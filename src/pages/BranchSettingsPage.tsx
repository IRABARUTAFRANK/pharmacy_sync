import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Btn, Card, CardHeader, CATEGORY_DOT_COLORS, CenterAlert, inputStyle, Modal, SectionHeader, StatusBadge } from "../components"
import { useTranslation } from "../lib/i18n"
import type { TranslationKey } from "../lib/i18n/en"
import { branchLogoUrl, getMyBranchDetails, updateBranchDetails, uploadBranchLogo, type BranchLanguage, type PaymentMethod } from "../lib/branch"
import L from "leaflet"
import {
  ACCURACY_CIRCLE_CLASS, addBaseLayerToggle, geocodeAddress, getCurrentDeviceLocation, googleMapsLinkFor,
  OSM_ATTRIBUTION, OSM_TILE_URL, PHARMACY_ICON, reverseGeocode, toggleFullscreen, type GeocodeResult,
} from "../lib/maps"
import { updatePassword } from "../lib/auth"
import { createBranchDiscount, listBranchDiscounts, type BranchDiscount, type DiscountType } from "../lib/sales"
import { createBranchCategory, listBranchCategories, updateBranchCategory, type BranchCategory } from "../lib/categories"
import { inviteStaff, listBranchStaff, setStaffActive, updateStaffRole, type BranchUserRole, type StaffMember, type StaffRole } from "../lib/staff"
import { errorMessage } from "../lib/supabase"
import type { Role } from "../data"
import { PasswordInput } from "./AuthShell"
import StorageLocationsManager from "./StorageLocationsManager"

// Same shape as Overview's own widget-visibility switch, kept page-local like
// that one rather than promoted to components.tsx -- neither page needs the
// other's copy.
function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} onClick={disabled ? undefined : onChange} disabled={disabled}
      style={{
        width: 38, height: 21, borderRadius: 11, border: "none", cursor: disabled ? "not-allowed" : "pointer", padding: 0, flexShrink: 0,
        background: checked ? "var(--positive)" : "var(--border-strong)", position: "relative", transition: "background 0.15s",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: checked ? 19 : 2, width: 17, height: 17, borderRadius: "50%",
        background: "var(--surface)", transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
      }} />
    </button>
  )
}

// Every real alert trigger and delivery channel this app has today always
// fires/is on -- none of them have a stored "enabled" flag anywhere, so a
// live Switch here would toggle nothing. This mirrors that honestly instead
// of pretending a control exists that doesn't persist anywhere.
function AlwaysOnIndicator() {
  const { t } = useTranslation()
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
      <div style={{ width: 38, height: 21, borderRadius: 11, background: "var(--positive)", position: "relative", flexShrink: 0 }}>
        <span style={{ position: "absolute", top: 2, left: 19, width: 17, height: 17, borderRadius: "50%", background: "var(--surface)", boxShadow: "0 1px 3px rgba(0,0,0,0.25)" }} />
      </div>
      <span style={{ fontSize: 11, color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{t("branchSettings.alwaysOn")}</span>
    </div>
  )
}

// Falls back to Kigali when no pin has ever been set -- just a sensible
// starting view for the very first placement, not a meaningful default
// location (nothing is saved until the admin actually clicks/drags/uses
// their device location).
const DEFAULT_MAP_CENTER: L.LatLngTuple = [-1.9441, 30.0619]

// A draggable-pin picker on a Leaflet + OpenStreetMap map (free, no API key,
// no account, no billing -- see src/lib/maps.ts's own header). Kept in sync
// with external latitude/longitude changes (e.g. "Use my current location",
// an address search result) by its own effect below, so any of the four
// ways to move the pin -- device location, search, click, drag -- all flow
// through the same onChange back to the parent, which is the single source
// of truth for what's actually saved.
function BranchLocationMap({ latitude, longitude, accuracyMeters, onChange }: {
  latitude: number | null; longitude: number | null; accuracyMeters: number | null; onChange: (lat: number, lng: number) => void
}) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState<string | null>(null)
  const [tilesLoading, setTilesLoading] = useState(true)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const leafletDivRef = useRef<HTMLDivElement | null>(null)
  const leafletMapRef = useRef<L.Map | null>(null)
  const leafletMarkerRef = useRef<L.Marker | null>(null)
  const accuracyCircleRef = useRef<L.Circle | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // The whole wrapper (toolbar included, not just the tile canvas) goes
  // fullscreen together via the native browser API -- see
  // toggleFullscreen()'s own comment. Leaflet caches its container's pixel
  // size, so it needs an explicit nudge once the fullscreen transition
  // actually finishes; `fullscreenchange` (not the click handler itself) is
  // the right moment for that, on a short delay so the browser's own layout
  // settles first.
  useEffect(() => {
    function handleChange() {
      setIsFullscreen(document.fullscreenElement === wrapperRef.current)
      window.setTimeout(() => { leafletMapRef.current?.invalidateSize() }, 60)
    }
    document.addEventListener("fullscreenchange", handleChange)
    return () => document.removeEventListener("fullscreenchange", handleChange)
  }, [])

  // A quick pulse ring around the pin whenever it's placed/moved (drag,
  // click, "use my location", search, recenter) -- the same house style as
  // this app's other placement/success confirmations, just enough motion to
  // read as "placed here" without being distracting.
  function pulseAt(el: HTMLElement | null | undefined) {
    if (!el) return
    el.classList.remove("pin-drop-pulse")
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    void el.offsetWidth // restart the animation even if it's already mid-pulse
    el.classList.add("pin-drop-pulse")
  }

  useEffect(() => {
    if (!leafletDivRef.current) return
    const center: L.LatLngTuple = latitude != null && longitude != null ? [latitude, longitude] : DEFAULT_MAP_CENTER
    setTilesLoading(true)
    const map = L.map(leafletDivRef.current, {
      attributionControl: true, zoomAnimation: true, easeLinearity: 0.25,
      zoomSnap: 0.5, wheelPxPerZoomLevel: 90, // finer-grained, smoother scroll-zoom than Leaflet's default whole-integer steps
    }).setView(center, latitude != null ? 15 : 7)
    const streetLayer = L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map)
    streetLayer.once("load", () => setTilesLoading(false)) // fires once every currently-visible tile has actually loaded in
    // Satellite view lets whoever is placing the pin cross-check it against
    // real imagery -- e.g. confirming the pin actually sits on the
    // pharmacy's rooftop rather than a neighboring building, which is
    // exactly the kind of check the GPS-accuracy warning above this map
    // asks for when the device's own reading is low-confidence.
    addBaseLayerToggle(map, streetLayer, t("branchSettings.mapLayerMap"), t("branchSettings.mapLayerSatellite"))
    L.control.scale({ imperial: false }).addTo(map)
    const marker = L.marker(center, { draggable: true, icon: PHARMACY_ICON }).addTo(map)
    marker.on("dragend", () => {
      const pos = marker.getLatLng()
      pulseAt(marker.getElement())
      onChangeRef.current(pos.lat, pos.lng)
    })
    map.on("click", (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng)
      pulseAt(marker.getElement())
      onChangeRef.current(e.latlng.lat, e.latlng.lng)
    })
    leafletMapRef.current = map
    leafletMarkerRef.current = marker
    return () => { map.remove(); leafletMapRef.current = null; leafletMarkerRef.current = null; accuracyCircleRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = leafletMapRef.current
    const marker = leafletMarkerRef.current
    if (latitude == null || longitude == null || !map || !marker) return
    const pos: L.LatLngTuple = [latitude, longitude]
    map.flyTo(pos, Math.max(map.getZoom(), 15), { duration: 1.1, easeLinearity: 0.25 })
    marker.setLatLng(pos)
  }, [latitude, longitude])

  // The device's own GPS confidence radius, drawn as a soft pulsing circle
  // around the pin -- only for an actual device reading (a search result or
  // a manual drag/click clears accuracyMeters back to null, see
  // useCurrentLocation/pickSearchResult/BranchLocationMap's own onChange
  // above), so it never implies false precision for a pin placed
  // deliberately rather than read off a GPS sensor.
  useEffect(() => {
    const map = leafletMapRef.current
    if (!map) return
    if (accuracyCircleRef.current) { map.removeLayer(accuracyCircleRef.current); accuracyCircleRef.current = null }
    if (latitude == null || longitude == null || accuracyMeters == null) return
    const circle = L.circle([latitude, longitude], {
      radius: accuracyMeters, color: "var(--primary, #1e5fa8)", weight: 1, fillOpacity: 0.1, className: ACCURACY_CIRCLE_CLASS,
    }).addTo(map)
    circle.bindTooltip(t("branchSettings.locationAccuracyRadiusLabel", { meters: String(Math.round(accuracyMeters)) }))
    accuracyCircleRef.current = circle
  }, [latitude, longitude, accuracyMeters, t])

  function recenter() {
    if (latitude == null || longitude == null || !leafletMapRef.current) return
    leafletMapRef.current.flyTo([latitude, longitude], 15, { duration: 0.8, easeLinearity: 0.25 })
    pulseAt(leafletMarkerRef.current?.getElement())
  }

  return (
    <div ref={wrapperRef} style={isFullscreen ? { background: "var(--surface)", padding: 16, display: "flex", flexDirection: "column", height: "100vh", boxSizing: "border-box" } : undefined}>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 8 }}>
        <button
          type="button"
          title={t("branchSettings.mapRecenter")}
          onClick={recenter}
          disabled={latitude == null || longitude == null}
          style={{
            width: 26, height: 26, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
            border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink-mid)",
            cursor: latitude == null ? "default" : "pointer", fontSize: 13, opacity: latitude == null ? 0.4 : 1,
          }}
        >⌖</button>
        <button
          type="button"
          title={isFullscreen ? t("branchSettings.mapExitFullscreen") : t("branchSettings.mapFullscreen")}
          onClick={() => { setFullscreenError(null); if (wrapperRef.current) toggleFullscreen(wrapperRef.current, setFullscreenError) }}
          style={{
            width: 26, height: 26, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
            border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink-mid)", cursor: "pointer", fontSize: 12,
          }}
        >{isFullscreen ? "⤡" : "⤢"}</button>
      </div>
      {fullscreenError && <p style={{ margin: "0 0 8px", fontSize: 11, color: "#b45309" }}>{fullscreenError}</p>}
      <div className="animate-fade-in" style={{ position: "relative", width: "100%", height: isFullscreen ? "100%" : 260, flex: isFullscreen ? 1 : undefined, borderRadius: 10, overflow: "hidden", background: "var(--bg)" }}>
        <div ref={leafletDivRef} style={{ width: "100%", height: "100%" }} />
        {tilesLoading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "var(--bg)", fontSize: 12, color: "var(--ink-muted)", pointerEvents: "none" }}>
            <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--primary)", animation: "psync-spin 0.8s linear infinite" }} />
            {t("branchSettings.mapLoadingTiles")}
          </div>
        )}
      </div>
    </div>
  )
}

// One row per setting, matching the reference layout: label + description +
// (optional) the real column it writes to + (optional) a plain-language
// warning, with the actual control on the right. The db-column annotation is
// only ever the true column/RPC param -- never shown next to a field that
// doesn't actually persist anywhere.
function SettingRow({ label, description, dbRef, warning, last, children }: {
  label: string; description?: string; dbRef?: string; warning?: string; last?: boolean; children: ReactNode
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 24, padding: "18px 0", borderBottom: last ? "none" : "1px solid var(--bg-alt)", alignItems: "start" }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 4, lineHeight: 1.5 }}>{description}</div>}
        {dbRef && <div style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--font-mono)", marginTop: 6 }}>{dbRef}</div>}
        {warning && <div style={{ fontSize: 11, color: "#d97706", marginTop: 6, fontWeight: 600 }}>⚠ {warning}</div>}
      </div>
      <div>{children}</div>
    </div>
  )
}

type SettingsTab = "profile" | "pos" | "inventory" | "finance" | "users" | "categories" | "storage" | "alerts"

const SETTINGS_TABS: { id: SettingsTab; icon: string; labelKey: TranslationKey }[] = [
  { id: "profile", icon: "🏥", labelKey: "branchSettings.tabProfile" },
  { id: "pos", icon: "🧾", labelKey: "branchSettings.tabPos" },
  { id: "inventory", icon: "📦", labelKey: "branchSettings.tabInventory" },
  { id: "finance", icon: "💰", labelKey: "branchSettings.tabFinance" },
  { id: "users", icon: "👥", labelKey: "branchSettings.tabUsers" },
  { id: "categories", icon: "📁", labelKey: "branchSettings.tabCategories" },
  { id: "storage", icon: "🗄️", labelKey: "branchSettings.tabStorage" },
  { id: "alerts", icon: "🔔", labelKey: "branchSettings.tabAlerts" },
]

const STATUS_COLORS: Record<string, { c: string; bg: string }> = {
  active: { c: "#16a34a", bg: "#d1fae5" },
  locked: { c: "#dc2626", bg: "#fef2f2" },
  pending: { c: "#d97706", bg: "#fef3c7" },
  otp_sent: { c: "#d97706", bg: "#fef3c7" },
  denied: { c: "#dc2626", bg: "#fef2f2" },
}

// Reuses the Super Admin Portal's own status labels (admin.status*) rather
// than a second, parallel set of translations for the same five values.
const STATUS_LABEL_KEY: Record<string, "admin.statusPending" | "admin.statusOtpSent" | "admin.statusActive" | "admin.statusLocked" | "admin.statusDenied"> = {
  pending: "admin.statusPending", otp_sent: "admin.statusOtpSent", active: "admin.statusActive", locked: "admin.statusLocked", denied: "admin.statusDenied",
}

// Owner and Manager already have real, distinct, backend-enforced access
// today; "Staff" here is the existing "seller" role relabeled for this UI --
// POS + Patients + Help only, exactly what a seller login has always been
// limited to (see NAV_ITEMS in data.ts).
const ROLE_COLORS: Record<BranchUserRole, { c: string; bg: string }> = {
  owner: { c: "#7c3aed", bg: "#ede9fe" },
  manager: { c: "#2563eb", bg: "#dbeafe" },
  seller: { c: "#4b5563", bg: "#f3f4f6" },
}

const ROLE_LABEL_KEY: Record<BranchUserRole, TranslationKey> = {
  owner: "branchSettings.roleOwner", manager: "branchSettings.roleManager", seller: "branchSettings.roleStaff",
}

const ROLE_DESC_KEY: Record<BranchUserRole, TranslationKey> = {
  owner: "branchSettings.roleDescOwner", manager: "branchSettings.roleDescManager", seller: "branchSettings.roleDescStaff",
}


function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase()
}

function RoleBadge({ role }: { role: BranchUserRole }) {
  const { t } = useTranslation()
  const colors = ROLE_COLORS[role]
  return <StatusBadge label={t(ROLE_LABEL_KEY[role])} color={colors.c} bg={colors.bg} />
}

function Avatar({ fullName, role }: { fullName: string; role: BranchUserRole }) {
  const colors = ROLE_COLORS[role]
  return (
    <div style={{
      width: 38, height: 38, borderRadius: "50%", background: colors.bg, color: colors.c,
      display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flexShrink: 0,
    }}>
      {initials(fullName)}
    </div>
  )
}

function InviteStaffModal({ onClose, onCreated, branchId, isOwner }: { onClose: () => void; onCreated: () => void; branchId?: string; isOwner: boolean }) {
  const { t } = useTranslation()
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  // A manager can only ever create a seller -- create-branch-seller (the
  // Edge Function this submits to) already rejects a manager-created
  // "manager" login server-side ("Only the branch owner may create a
  // manager login"), so a manager was previously shown the choice anyway
  // and only found out it was rejected after submitting. Defaulting to,
  // and here fixing the choice at, "seller" for a non-owner caller matches
  // the real server-side rule instead of surfacing it as a late error.
  const [role, setRole] = useState<StaffRole>("seller")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!fullName.trim()) { setError(t("branchSettings.usersNameRequired")); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError(t("branchSettings.usersEmailInvalid")); return }
    if (password.length < 6) { setError(t("branchSettings.usersPasswordTooShort")); return }
    setBusy(true)
    setError(null)
    try {
      await inviteStaff(fullName.trim(), email.trim(), password, role, branchId)
      onCreated()
    } catch (reason) {
      const raw = errorMessage(reason, t("branchSettings.usersInviteError"))
      setError(raw.toLowerCase().includes("failed to send a request") ? t("branchSettings.usersFunctionNotDeployed") : raw)
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={t("branchSettings.inviteStaffTitle")} onClose={onClose} width={440}>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("branchSettings.inviteStaffIntro")}</p>
      {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.usersFullNameLabel")}</label>
        <input value={fullName} onChange={e => setFullName(e.target.value)} style={inputStyle} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.usersEmailLabel")}</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.usersPasswordLabel")}</label>
        <PasswordInput value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} placeholder={t("branchSettings.usersPasswordPlaceholder")} />
        <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("branchSettings.usersPasswordHint")}</p>
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.usersRoleLabel")}</label>
        {isOwner ? (
          <div style={{ display: "flex", gap: 8 }}>
            {(["manager", "seller"] as StaffRole[]).map(r => (
              <button key={r} type="button" onClick={() => setRole(r)} style={{
                flex: 1, padding: "10px", borderRadius: 8, fontFamily: "inherit", cursor: "pointer",
                border: `1.5px solid ${role === r ? "var(--primary)" : "var(--border)"}`,
                background: role === r ? "var(--primary-light)" : "var(--surface)",
                color: role === r ? "var(--primary)" : "var(--ink-mid)", fontWeight: role === r ? 700 : 500, fontSize: 12,
              }}>{t(ROLE_LABEL_KEY[r])}</button>
            ))}
          </div>
        ) : (
          <div style={{
            padding: "10px", borderRadius: 8, border: "1.5px solid var(--primary)",
            background: "var(--primary-light)", color: "var(--primary)", fontWeight: 700, fontSize: 12,
          }}>
            {t(ROLE_LABEL_KEY.seller)}
            <span style={{ display: "block", marginTop: 2, fontSize: 10, fontWeight: 500, color: "var(--ink-muted)" }}>
              {t("branchSettings.inviteManagerRestrictionNote")}
            </span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" onClick={onClose}>{t("branchSettings.usersCancel")}</Btn>
        <Btn variant="primary" onClick={() => void submit()}>{busy ? t("branchSettings.usersInviting") : t("branchSettings.usersInviteSubmit")}</Btn>
      </div>
    </div>
  </Modal>
}

function ChangeRoleModal({ member, onClose, onChanged, branchId }: { member: StaffMember; onClose: () => void; onChanged: () => void; branchId?: string }) {
  const { t } = useTranslation()
  const [role, setRole] = useState<StaffRole>(member.role === "manager" ? "manager" : "seller")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await updateStaffRole(member.id, role, branchId)
      onChanged()
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.usersRoleChangeError")))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={t("branchSettings.changeRoleTitle", { name: member.fullName })} onClose={onClose} width={400}>
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        {(["manager", "seller"] as StaffRole[]).map(r => (
          <button key={r} type="button" onClick={() => setRole(r)} style={{
            flex: 1, padding: "10px", borderRadius: 8, fontFamily: "inherit", cursor: "pointer",
            border: `1.5px solid ${role === r ? "var(--primary)" : "var(--border)"}`,
            background: role === r ? "var(--primary-light)" : "var(--surface)",
            color: role === r ? "var(--primary)" : "var(--ink-mid)", fontWeight: role === r ? 700 : 500, fontSize: 12,
          }}>{t(ROLE_LABEL_KEY[r])}</button>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" onClick={onClose}>{t("branchSettings.usersCancel")}</Btn>
        <Btn variant="primary" onClick={() => void submit()}>{busy ? t("branchSettings.usersSaving") : t("branchSettings.usersSaveRole")}</Btn>
      </div>
    </div>
  </Modal>
}

function CategoryModal({ initial, onClose, onSaved }: {
  initial?: BranchCategory
  onClose: () => void
  onSaved: (name: string, description: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!name.trim()) { setError(t("branchSettings.categoryNameRequired")); return }
    setBusy(true)
    setError(null)
    try {
      await onSaved(name.trim(), description.trim())
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.categorySaveError")))
      setBusy(false)
    }
  }

  return <Modal title={initial ? t("branchSettings.editCategoryTitle") : t("branchSettings.addCategoryTitle")} onClose={onClose} width={420}>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.categoryNameLabel")}</label>
        <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.categoryDescriptionLabel")}</label>
        <input value={description} onChange={e => setDescription(e.target.value)} style={inputStyle} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" onClick={onClose}>{t("branchSettings.usersCancel")}</Btn>
        <Btn variant="primary" onClick={() => void submit()}>{busy ? t("branchSettings.usersSaving") : t("branchSettings.categorySave")}</Btn>
      </div>
    </div>
  </Modal>
}

// `onLogoSaved` (App.tsx) lets the sidebar's own logo update the moment a
// save here actually persists a new one -- without it, the sidebar would
// only pick up the change on the next sign-in/reload, same staleness the
// receipt doesn't have (it re-fetches the branch row fresh every print).
// A branch manager gets full staff/seller oversight and day-to-day settings
// here, same page as the owner -- but never the Finance tab (bank/momo
// payout details) or the Legal card in Profile (license/TIN/EBM), which stay
// owner-only both here and, more importantly, server-side in
// update_branch_details() -- this filter is a convenience, not the boundary.
// `branchId` -- undefined for the normal case (your own branch); an
// org_owner/org_manager viewing another branch in their organization passes
// its id here, and every load/save below forwards it to the matching RPC's
// effective_branch_id() resolution. `role` is already the EFFECTIVE role for
// that target branch (App.tsx elevates it to "owner" when viewingBranchId
// differs from the caller's own branch, since effective_branch_id() only
// ever allows that for an org_owner/org_manager, who has full authority
// there) -- this page never needs to know the difference itself.
export default function BranchSettingsPage({ onLogoSaved, role, branchId }: { onLogoSaved?: (url: string | null) => void; role: Role; branchId?: string }) {
  const { t } = useTranslation()
  const isOwner = role === "owner"
  const visibleTabs = isOwner ? SETTINGS_TABS : SETTINGS_TABS.filter(tab => tab.id !== "finance")
  const [activeTab, setActiveTab] = useState<SettingsTab>("profile")
  const [organizationId, setOrganizationId] = useState<string | null>(null)
  // A plain branch manager at a branch an organization set up: everything
  // except address/phone/location is owned by whoever configured the
  // branch (org_owner/org_manager), mirroring update_branch_details()'s own
  // v_org_restricted -- this is the convenience/UI side of that, the RPC
  // itself is the real boundary regardless of what this page renders.
  const orgRestricted = !isOwner && organizationId != null
  const lockedInputStyle = { ...inputStyle, opacity: 0.6, cursor: "not-allowed", background: "var(--bg-alt)" }
  const orgManagedNote = orgRestricted ? t("branchSettings.orgManagedFieldNote") : undefined

  const [branchName, setBranchName] = useState("")
  const [address, setAddress] = useState("")
  const [phone, setPhone] = useState("")
  const [latitude, setLatitude] = useState<number | null>(null)
  const [longitude, setLongitude] = useState<number | null>(null)
  const [email, setEmail] = useState("")
  const [website, setWebsite] = useState("")
  const [tin, setTin] = useState("")
  const [licenseNumber, setLicenseNumber] = useState("")
  const [licenseExpiryDate, setLicenseExpiryDate] = useState("")
  const [ebmDeviceSerial, setEbmDeviceSerial] = useState("")
  const [defaultLanguage, setDefaultLanguage] = useState<BranchLanguage>("en")
  const [logoPath, setLogoPath] = useState<string | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [bankAccountNumber, setBankAccountNumber] = useState("")
  const [bankAccountName, setBankAccountName] = useState("")
  const [momoPayNumber, setMomoPayNumber] = useState("")
  const [reminderHours, setReminderHours] = useState(6)
  const [expiryAlertThresholdDays, setExpiryAlertThresholdDays] = useState(60)
  const [defaultReorderMin, setDefaultReorderMin] = useState(0)
  const [receiptNumberPrefix, setReceiptNumberPrefix] = useState("RCT")
  const [posCashEnabled, setPosCashEnabled] = useState(true)
  const [posMtnMomoEnabled, setPosMtnMomoEnabled] = useState(true)
  const [posAirtelMoneyEnabled, setPosAirtelMoneyEnabled] = useState(true)
  const [posCardEnabled, setPosCardEnabled] = useState(false)
  const [posInsuranceEnabled, setPosInsuranceEnabled] = useState(true)
  const [posDefaultPaymentMethod, setPosDefaultPaymentMethod] = useState<PaymentMethod>("cash")
  const [posRequirePatientName, setPosRequirePatientName] = useState(false)
  const [posAllowDiscounts, setPosAllowDiscounts] = useState(true)
  const [posShowPatientHistory, setPosShowPatientHistory] = useState(true)
  const [discounts, setDiscounts] = useState<BranchDiscount[]>([])
  const [newDiscountName, setNewDiscountName] = useState("")
  const [newDiscountType, setNewDiscountType] = useState<DiscountType>("percentage")
  const [newDiscountValue, setNewDiscountValue] = useState("")
  const [creatingDiscount, setCreatingDiscount] = useState(false)
  const [branchCode, setBranchCode] = useState<string | null>(null)
  const [status, setStatus] = useState("active")
  const [createdAt, setCreatedAt] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  // CenterAlert is keyed off this, not successMsg itself: the save/change
  // success text is the same constant string every time, so calling
  // setSuccessMsg(sameString) twice in a row is a no-op to React (identical
  // state, no re-render) -- the toast would only ever appear on the FIRST
  // save, silently stop showing on every one after that. A bump-on-every-
  // success counter guarantees a fresh key regardless of whether the
  // message text repeats.
  const [successSeq, setSuccessSeq] = useState(0)

  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null)
  const [passwordSuccessSeq, setPasswordSuccessSeq] = useState(0)

  const [staff, setStaff] = useState<StaffMember[]>([])
  const [staffLoading, setStaffLoading] = useState(true)
  const [staffError, setStaffError] = useState<string | null>(null)
  const [showInvite, setShowInvite] = useState(false)
  const [changeRoleTarget, setChangeRoleTarget] = useState<StaffMember | null>(null)

  const [categories, setCategories] = useState<BranchCategory[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(true)
  const [categoriesError, setCategoriesError] = useState<string | null>(null)
  const [showAddCategory, setShowAddCategory] = useState(false)
  const [editCategoryTarget, setEditCategoryTarget] = useState<BranchCategory | null>(null)
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const details = await getMyBranchDetails(branchId)
      setBranchName(details.name)
      setAddress(details.address ?? "")
      setPhone(details.phone ?? "")
      setLatitude(details.latitude)
      setLongitude(details.longitude)
      setOrganizationId(details.organizationId)
      setEmail(details.email ?? "")
      setWebsite(details.website ?? "")
      setTin(details.tin ?? "")
      setLicenseNumber(details.licenseNumber ?? "")
      setLicenseExpiryDate(details.licenseExpiryDate ?? "")
      setEbmDeviceSerial(details.ebmDeviceSerial ?? "")
      setDefaultLanguage(details.defaultLanguage)
      setLogoPath(details.logoPath)
      setBankAccountNumber(details.bankAccountNumber ?? "")
      setBankAccountName(details.bankAccountName ?? "")
      setMomoPayNumber(details.momoPayNumber ?? "")
      setReminderHours(details.outOfStockReminderHours)
      setExpiryAlertThresholdDays(details.expiryAlertThresholdDays)
      setDefaultReorderMin(details.defaultReorderMin)
      setReceiptNumberPrefix(details.receiptNumberPrefix)
      setPosCashEnabled(details.posCashEnabled)
      setPosMtnMomoEnabled(details.posMtnMomoEnabled)
      setPosAirtelMoneyEnabled(details.posAirtelMoneyEnabled)
      setPosCardEnabled(details.posCardEnabled)
      setPosInsuranceEnabled(details.posInsuranceEnabled)
      setPosDefaultPaymentMethod(details.posDefaultPaymentMethod)
      setPosRequirePatientName(details.posRequirePatientName)
      setPosAllowDiscounts(details.posAllowDiscounts)
      setPosShowPatientHistory(details.posShowPatientHistory)
      setBranchCode(details.branchCode)
      setStatus(details.status)
      setCreatedAt(details.createdAt)
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.loadError")))
    } finally {
      setLoading(false)
    }
  }, [t, branchId])

  useEffect(() => { void refresh() }, [refresh])

  const refreshDiscounts = useCallback(async () => {
    try {
      setDiscounts(await listBranchDiscounts(branchId))
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.discountsLoadError")))
    }
  }, [t, branchId])

  useEffect(() => { void refreshDiscounts() }, [refreshDiscounts])

  const refreshStaff = useCallback(async () => {
    setStaffLoading(true)
    setStaffError(null)
    try {
      setStaff(await listBranchStaff(branchId))
    } catch (reason) {
      setStaffError(errorMessage(reason, t("branchSettings.usersLoadError")))
    } finally {
      setStaffLoading(false)
    }
  }, [t, branchId])

  useEffect(() => { void refreshStaff() }, [refreshStaff])

  async function toggleStaffActive(member: StaffMember) {
    try {
      await setStaffActive(member.id, !member.isActive, branchId)
      void refreshStaff()
    } catch (reason) {
      setStaffError(errorMessage(reason, t("branchSettings.usersToggleError")))
    }
  }

  const refreshCategories = useCallback(async () => {
    setCategoriesLoading(true)
    setCategoriesError(null)
    try {
      setCategories(await listBranchCategories(branchId))
    } catch (reason) {
      setCategoriesError(errorMessage(reason, t("branchSettings.categoriesLoadError")))
    } finally {
      setCategoriesLoading(false)
    }
  }, [t, branchId])

  useEffect(() => { void refreshCategories() }, [refreshCategories])

  async function addDiscount() {
    const value = Number(newDiscountValue)
    if (!newDiscountName.trim() || !Number.isFinite(value) || value < 0) {
      setError(t("branchSettings.discountInvalidError"))
      return
    }
    setCreatingDiscount(true)
    setError(null)
    try {
      await createBranchDiscount(newDiscountName.trim(), newDiscountType, value, undefined, undefined, branchId)
      setNewDiscountName("")
      setNewDiscountValue("")
      await refreshDiscounts()
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.discountCreateError")))
    } finally {
      setCreatingDiscount(false)
    }
  }

  const [locatingDevice, setLocatingDevice] = useState(false)
  const [locateError, setLocateError] = useState<string | null>(null)
  // GPS accuracy radius (meters) from the last device-location reading --
  // null once any OTHER source (search, click, drag) has since moved the
  // pin, since it no longer describes where the pin actually is.
  const [locateAccuracy, setLocateAccuracy] = useState<number | null>(null)
  const [addressQuery, setAddressQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([])
  // Reverse-geocoded confirmation text for whatever the pin's CURRENT
  // coordinates are -- the "does this actually look right" check, kept in
  // sync by the debounced effect below regardless of which of the four
  // ways (device location, search, click, drag) moved the pin.
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null)
  const [resolvingAddress, setResolvingAddress] = useState(false)

  useEffect(() => {
    if (latitude == null || longitude == null) { setResolvedAddress(null); return }
    let cancelled = false
    setResolvingAddress(true)
    const timer = setTimeout(() => {
      reverseGeocode(latitude, longitude)
        .then(address => { if (!cancelled) setResolvedAddress(address) })
        .catch(() => { if (!cancelled) setResolvedAddress(null) })
        .finally(() => { if (!cancelled) setResolvingAddress(false) })
    }, 600) // debounced -- a drag fires many intermediate positions; only the settled one needs a lookup
    return () => { cancelled = true; clearTimeout(timer) }
  }, [latitude, longitude])

  async function useCurrentLocation() {
    setLocatingDevice(true)
    setLocateError(null)
    try {
      const pos = await getCurrentDeviceLocation()
      setLatitude(pos.lat)
      setLongitude(pos.lng)
      setLocateAccuracy(pos.accuracyMeters)
    } catch (reason) {
      setLocateError(errorMessage(reason, t("branchSettings.locateError")))
    } finally {
      setLocatingDevice(false)
    }
  }

  // The precise, address-driven alternative to device GPS -- the actual fix
  // for "the device may be displaced, not the pharmacy": typing the
  // pharmacy's real registered address and picking the matching result
  // pins the exact spot regardless of where whoever is doing the setup
  // happens to physically be. Only fires on an explicit Search click/Enter
  // press, never per keystroke -- see geocodeAddress()'s own header for why.
  async function searchAddress() {
    if (!addressQuery.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      const results = await geocodeAddress(addressQuery)
      setSearchResults(results)
      if (results.length === 0) setSearchError(t("branchSettings.locationSearchEmpty"))
    } catch (reason) {
      setSearchError(errorMessage(reason, t("branchSettings.locationSearchError")))
    } finally {
      setSearching(false)
    }
  }

  function pickSearchResult(result: GeocodeResult) {
    setLatitude(result.lat)
    setLongitude(result.lng)
    setLocateAccuracy(null) // this pin came from a searched address, not a device reading
    setSearchResults([])
    setAddressQuery(result.displayName)
  }

  async function pickLogo(file: File | null) {
    if (!file) return
    setLogoPreview(URL.createObjectURL(file))
    setUploadingLogo(true)
    setError(null)
    try {
      const path = await uploadBranchLogo(file)
      setLogoPath(path)
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.logoUploadError")))
    } finally {
      setUploadingLogo(false)
    }
  }

  // One shared save for the whole record -- every field from every tab is
  // sent together in one update_branch_details() call regardless of which
  // tab happens to be open, the same way the pre-redesign page already saved
  // its two visually-separate cards as a single action.
  async function save() {
    if (!branchName.trim()) { setError(t("branchSettings.nameRequiredError")); return }
    setSaving(true)
    setError(null)
    try {
      await updateBranchDetails({
        address: address.trim(), phone: phone.trim(), tin: tin.trim(), logoPath,
        bankAccountNumber: bankAccountNumber.trim(), bankAccountName: bankAccountName.trim(), momoPayNumber: momoPayNumber.trim(),
        outOfStockReminderHours: reminderHours,
        name: branchName.trim(), email: email.trim(), website: website.trim(),
        licenseNumber: licenseNumber.trim(), licenseExpiryDate: licenseExpiryDate.trim() || null, ebmDeviceSerial: ebmDeviceSerial.trim(),
        defaultLanguage,
        receiptNumberPrefix: receiptNumberPrefix.trim() || "RCT",
        posCashEnabled, posMtnMomoEnabled, posAirtelMoneyEnabled, posCardEnabled, posInsuranceEnabled,
        posDefaultPaymentMethod, posRequirePatientName, posAllowDiscounts, posShowPatientHistory,
        expiryAlertThresholdDays, defaultReorderMin,
        latitude, longitude,
      }, branchId)
      setSuccessMsg(t("branchSettings.saveSuccess"))
      setSuccessSeq(seq => seq + 1)
      onLogoSaved?.(logoPath ? branchLogoUrl(logoPath) : null)
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.saveError")))
    } finally {
      setSaving(false)
    }
  }

  async function changePassword() {
    setPasswordError(null)
    if (newPassword.length < 8) { setPasswordError(t("branchSettings.passwordTooShort")); return }
    if (newPassword !== confirmPassword) { setPasswordError(t("branchSettings.passwordMismatch")); return }
    setChangingPassword(true)
    try {
      await updatePassword(newPassword)
      setNewPassword("")
      setConfirmPassword("")
      setPasswordSuccess(t("branchSettings.passwordChangeSuccess"))
      setPasswordSuccessSeq(seq => seq + 1)
    } catch (reason) {
      setPasswordError(errorMessage(reason, t("branchSettings.passwordChangeError")))
    } finally {
      setChangingPassword(false)
    }
  }

  const logoSrc = logoPreview ?? (logoPath ? branchLogoUrl(logoPath) : null)
  const statusColor = STATUS_COLORS[status] ?? STATUS_COLORS.active

  return <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    {error && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>{error}</div>}
    {successMsg && <CenterAlert key={successSeq} message={successMsg} tone="success" />}
    {passwordSuccess && <CenterAlert key={passwordSuccessSeq} message={passwordSuccess} tone="success" />}

    <SectionHeader title={t("page.branch")} subtitle={t("branchSettings.subtitle")} />

    {loading ? <Card><p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.loading")}</p></Card> : (
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Settings sub-nav -- sticky within <main>'s own scroll (App.tsx is
            the only scrolling ancestor), so a long tab like Profile scrolls
            its content while the nav + Save button stay put instead of
            scrolling away and leaving blank space where the nav used to be. */}
        <div style={{ width: 230, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12, position: "sticky", top: 0, maxHeight: "calc(100vh - 40px)", overflowY: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "0 4px" }}>
            {t("branchSettings.settingsNavTitle")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {visibleTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                  border: `1.5px solid ${activeTab === tab.id ? "var(--primary)" : "transparent"}`,
                  background: activeTab === tab.id ? "var(--primary-light)" : "transparent",
                  color: activeTab === tab.id ? "var(--primary)" : "var(--ink-mid)",
                  fontWeight: activeTab === tab.id ? 700 : 500, fontSize: 13, textAlign: "left",
                }}
              >
                <span>{tab.icon}</span>{t(tab.labelKey)}
              </button>
            ))}
          </div>
          <Btn variant="primary" onClick={() => void save()} style={{ justifyContent: "center", marginTop: 8 }}>
            {saving ? t("branchSettings.saving") : t("branchSettings.save")}
          </Btn>
        </div>

        {/* Tab content */}
        <div style={{ flex: "1 1 480px", minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>
          {activeTab === "profile" && (
            <>
              <Card>
                <CardHeader icon="🏥" title={t("branchSettings.identityTitle")} subtitle={t("branchSettings.identitySubtitle")} />
                <SettingRow label={t("branchSettings.logoLabel")} description={uploadingLogo ? t("branchSettings.logoUploading") : t("branchSettings.logoHint")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 56, height: 56, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
                      {logoSrc ? <img src={logoSrc} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ fontSize: 9, color: "var(--ink-faint)" }}>{t("branchSettings.noLogo")}</span>}
                    </div>
                    <input type="file" accept="image/*" onChange={e => void pickLogo(e.target.files?.[0] ?? null)} style={{ fontSize: 11 }} disabled={uploadingLogo} />
                  </div>
                </SettingRow>
                <SettingRow label={t("branchSettings.nameLabel")} description={t("branchSettings.nameHint")} dbRef="branches.name" warning={orgManagedNote}>
                  <input value={branchName} onChange={e => setBranchName(e.target.value)} style={orgRestricted ? lockedInputStyle : inputStyle} disabled={orgRestricted} />
                </SettingRow>
                <SettingRow label={t("branchSettings.addressLabel")} description={t("branchSettings.addressHint")} dbRef="branches.address">
                  <input value={address} onChange={e => setAddress(e.target.value)} style={inputStyle} />
                </SettingRow>
                <SettingRow label={t("branchSettings.phoneLabel")} description={t("branchSettings.phoneHint")} dbRef="branches.phone">
                  <input value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} />
                </SettingRow>
                <SettingRow label={t("branchSettings.emailLabel")} description={t("branchSettings.emailHint")} dbRef="branches.email" warning={orgManagedNote}>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={orgRestricted ? lockedInputStyle : inputStyle} disabled={orgRestricted} />
                </SettingRow>
                <SettingRow label={t("branchSettings.websiteLabel")} description={t("branchSettings.websiteHint")} dbRef="branches.website" last warning={orgManagedNote}>
                  <input value={website} onChange={e => setWebsite(e.target.value)} placeholder="www.mypharmacy.rw" style={orgRestricted ? lockedInputStyle : inputStyle} disabled={orgRestricted} />
                </SettingRow>
              </Card>

              <Card>
                <CardHeader icon="📍" title={t("branchSettings.locationTitle")} subtitle={t("branchSettings.locationSubtitle")} />
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Address search -- the precise, professional way to set
                      this: typing the pharmacy's real registered address
                      finds its exact spot regardless of where whoever is
                      doing the setup happens to physically be standing.
                      Explicit Search action only (button or Enter), never
                      live-as-you-type -- see geocodeAddress()'s own comment. */}
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={addressQuery}
                      onChange={e => setAddressQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void searchAddress() } }}
                      placeholder={t("branchSettings.locationSearchPlaceholder")}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <Btn variant="secondary" small onClick={() => void searchAddress()}>
                      {searching ? t("branchSettings.locationSearching") : `🔍 ${t("branchSettings.locationSearchButton")}`}
                    </Btn>
                  </div>
                  {searchError && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{searchError}</p>}
                  {searchResults.length > 0 && (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                      {searchResults.map((r, i) => (
                        <button
                          key={`${r.lat},${r.lng}`}
                          onClick={() => pickSearchResult(r)}
                          style={{
                            display: "block", width: "100%", textAlign: "left", padding: "8px 10px", fontSize: 12,
                            background: "var(--surface)", border: "none", borderTop: i === 0 ? "none" : "1px solid var(--bg-alt)",
                            cursor: "pointer", fontFamily: "inherit", color: "var(--ink)",
                          }}
                        >
                          {r.displayName}
                        </button>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                      {latitude != null && longitude != null
                        ? t("branchSettings.locationSet", { lat: latitude.toFixed(5), lng: longitude.toFixed(5) })
                        : t("branchSettings.locationNotSet")}
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      {latitude != null && longitude != null && (
                        <a href={googleMapsLinkFor(latitude, longitude)} target="_blank" rel="noreferrer" style={{ fontSize: 11, fontWeight: 600, color: "var(--primary)", alignSelf: "center", textDecoration: "none" }}>
                          {t("branchSettings.viewOnGoogleMaps")} ↗
                        </a>
                      )}
                      <Btn variant="secondary" small onClick={() => void useCurrentLocation()}>
                        {locatingDevice ? t("branchSettings.locating") : `📡 ${t("branchSettings.useMyLocation")}`}
                      </Btn>
                    </div>
                  </div>
                  {locateError && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{locateError}</p>}
                  {/* A device's GPS can drift, especially indoors or on a
                      laptop -- flagging a loose reading rather than quietly
                      trusting it is the actual fix for "the device might be
                      the one that's displaced, not the pharmacy". */}
                  {locateAccuracy != null && locateAccuracy > 100 && (
                    <p style={{ margin: 0, fontSize: 11, color: "#b45309" }}>
                      ⚠ {t("branchSettings.locationAccuracyWarning", { meters: String(Math.round(locateAccuracy)) })}
                    </p>
                  )}
                  <BranchLocationMap
                    latitude={latitude} longitude={longitude} accuracyMeters={locateAccuracy}
                    onChange={(lat, lng) => { setLatitude(lat); setLongitude(lng); setLocateAccuracy(null) }}
                  />
                  {/* The "does this actually look right" confirmation --
                      turns the raw coordinates back into a real address so
                      whoever set the pin can visually verify it against the
                      pharmacy's actual known address, rather than trusting
                      two bare numbers. */}
                  {(resolvingAddress || resolvedAddress) && (
                    <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>
                      📍 {resolvingAddress ? t("branchSettings.locationResolving") : t("branchSettings.locationResolved", { address: resolvedAddress ?? "" })}
                    </p>
                  )}
                  <p style={{ margin: 0, fontSize: 11, color: "var(--ink-faint)" }}>{t("branchSettings.locationHint")}</p>
                </div>
              </Card>

              {isOwner && (
                <Card>
                  <CardHeader icon="📋" title={t("branchSettings.legalTitle")} subtitle={t("branchSettings.legalSubtitle")} />
                  <SettingRow
                    label={t("branchSettings.licenseNumberLabel")} description={t("branchSettings.licenseNumberHint")}
                    dbRef="branches.license_number" warning={t("branchSettings.licenseNumberWarning")}
                  >
                    <input value={licenseNumber} onChange={e => setLicenseNumber(e.target.value)} style={inputStyle} />
                  </SettingRow>
                  <SettingRow label={t("branchSettings.licenseExpiryLabel")} description={t("branchSettings.licenseExpiryHint")} dbRef="branches.license_expiry_date">
                    <input type="date" value={licenseExpiryDate} onChange={e => setLicenseExpiryDate(e.target.value)} style={inputStyle} />
                  </SettingRow>
                  <SettingRow
                    label={t("branchSettings.tinLabel")} description={t("branchSettings.tinHint")}
                    dbRef="branches.tin" warning={t("branchSettings.tinWarning")}
                  >
                    <input value={tin} onChange={e => setTin(e.target.value)} style={inputStyle} />
                  </SettingRow>
                  <SettingRow label={t("branchSettings.ebmSerialLabel")} description={t("branchSettings.ebmSerialHint")} dbRef="branches.ebm_device_serial" last>
                    <input value={ebmDeviceSerial} onChange={e => setEbmDeviceSerial(e.target.value)} style={inputStyle} />
                  </SettingRow>
                </Card>
              )}

              <Card>
                <CardHeader icon="🌐" title={t("branchSettings.localeTitle")} subtitle={t("branchSettings.localeSubtitle")} />
                <SettingRow label={t("branchSettings.defaultLanguageLabel")} description={t("branchSettings.defaultLanguageHint")} dbRef="branches.default_language" last>
                  <select value={defaultLanguage} onChange={e => setDefaultLanguage(e.target.value as BranchLanguage)} style={inputStyle}>
                    <option value="en">English</option>
                    <option value="fr">Français</option>
                    <option value="rw">Ikinyarwanda</option>
                  </select>
                </SettingRow>
              </Card>

              <Card>
                <CardHeader icon="🔖" title={t("branchSettings.infoTitle")} />
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {branchCode && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.branchCodeLabel")}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace", color: "var(--ink)" }}>{branchCode}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.statusLabel")}</span>
                    <StatusBadge label={t(STATUS_LABEL_KEY[status] ?? "admin.statusActive")} color={statusColor.c} bg={statusColor.bg} />
                  </div>
                  {createdAt && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.memberSinceLabel")}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{new Date(createdAt).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>
              </Card>
            </>
          )}

          {activeTab === "pos" && (
            <>
              <Card>
                <CardHeader icon="🧾" title={t("branchSettings.receiptsTitle")} subtitle={t("branchSettings.receiptsSubtitle")} />
                <SettingRow
                  label={t("branchSettings.receiptPrefixLabel")} description={t("branchSettings.receiptPrefixHint")}
                  dbRef="receipts.receipt_number format" last
                >
                  <input value={receiptNumberPrefix} onChange={e => setReceiptNumberPrefix(e.target.value)} style={inputStyle} />
                </SettingRow>
              </Card>

              <Card>
                <CardHeader icon="💳" title={t("branchSettings.paymentMethodsTitle")} subtitle={t("branchSettings.paymentMethodsSubtitle")} />
                <SettingRow label={t("branchSettings.methodCashLabel")} description={t("branchSettings.methodCashHint")}>
                  <Switch checked={posCashEnabled} onChange={() => setPosCashEnabled(v => !v)} />
                </SettingRow>
                <SettingRow label={t("branchSettings.methodMtnLabel")} description={t("branchSettings.methodMtnHint")}>
                  <Switch checked={posMtnMomoEnabled} onChange={() => setPosMtnMomoEnabled(v => !v)} />
                </SettingRow>
                <SettingRow label={t("branchSettings.methodAirtelLabel")} description={t("branchSettings.methodAirtelHint")}>
                  <Switch checked={posAirtelMoneyEnabled} onChange={() => setPosAirtelMoneyEnabled(v => !v)} />
                </SettingRow>
                <SettingRow label={t("branchSettings.methodInsuranceLabel")} description={t("branchSettings.methodInsuranceHint")}>
                  <Switch checked={posInsuranceEnabled} onChange={() => setPosInsuranceEnabled(v => !v)} />
                </SettingRow>
                <SettingRow label={t("branchSettings.methodCardLabel")} description={t("branchSettings.methodCardHint")}>
                  <Switch checked={posCardEnabled} onChange={() => setPosCardEnabled(v => !v)} />
                </SettingRow>
                <SettingRow label={t("branchSettings.defaultMethodLabel")} description={t("branchSettings.defaultMethodHint")} last>
                  <select value={posDefaultPaymentMethod} onChange={e => setPosDefaultPaymentMethod(e.target.value as PaymentMethod)} style={inputStyle}>
                    {posCashEnabled && <option value="cash">{t("branchSettings.methodCashLabel")}</option>}
                    {posMtnMomoEnabled && <option value="mtn_momo">{t("branchSettings.methodMtnLabel")}</option>}
                    {posAirtelMoneyEnabled && <option value="airtel_money">{t("branchSettings.methodAirtelLabel")}</option>}
                    {posCardEnabled && <option value="card">{t("branchSettings.methodCardLabel")}</option>}
                  </select>
                </SettingRow>
              </Card>

              <Card>
                <CardHeader icon="⚙️" title={t("branchSettings.saleRulesTitle")} subtitle={t("branchSettings.saleRulesSubtitle")} />
                <SettingRow
                  label={t("branchSettings.requirePatientLabel")} description={t("branchSettings.requirePatientHint")}
                  dbRef="sales — patient field"
                >
                  <Switch checked={posRequirePatientName} onChange={() => setPosRequirePatientName(v => !v)} />
                </SettingRow>
                <SettingRow
                  label={t("branchSettings.allowDiscountsLabel")} description={t("branchSettings.allowDiscountsHint")}
                  dbRef="sales.discount_id"
                >
                  <Switch checked={posAllowDiscounts} onChange={() => setPosAllowDiscounts(v => !v)} />
                </SettingRow>
                <SettingRow
                  label={t("branchSettings.showHistoryLabel")} description={t("branchSettings.showHistoryHint")}
                  dbRef="sales — patient name lookup" last
                >
                  <Switch checked={posShowPatientHistory} onChange={() => setPosShowPatientHistory(v => !v)} />
                </SettingRow>
              </Card>

              <Card>
                <CardHeader icon="🏷️" title={t("branchSettings.discountsTitle")} subtitle={t("branchSettings.discountsSubtitle")} />
                {discounts.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--ink-muted)", margin: "0 0 14px" }}>{t("branchSettings.discountsEmpty")}</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                    {discounts.map(d => (
                      <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "var(--bg)", borderRadius: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{d.name}</span>
                        <span style={{ fontSize: 12, color: d.isCurrent ? "var(--ink-mid)" : "var(--ink-faint)" }}>
                          {d.discountType === "percentage" ? `${d.value}%` : `RWF ${d.value.toLocaleString()}`}
                          {!d.isCurrent && ` · ${t("branchSettings.discountExpired")}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <input value={newDiscountName} onChange={e => setNewDiscountName(e.target.value)} placeholder={t("branchSettings.discountNamePlaceholder")} style={{ ...inputStyle, flex: "1 1 160px" }} />
                  <select value={newDiscountType} onChange={e => setNewDiscountType(e.target.value as DiscountType)} style={{ ...inputStyle, width: 110, background: "var(--surface)" }}>
                    <option value="percentage">%</option>
                    <option value="fixed">RWF</option>
                  </select>
                  <input type="number" min={0} value={newDiscountValue} onChange={e => setNewDiscountValue(e.target.value)} placeholder={t("branchSettings.discountValuePlaceholder")} style={{ ...inputStyle, width: 100 }} />
                  <Btn variant="secondary" onClick={() => void addDiscount()}>{creatingDiscount ? t("branchSettings.discountAdding") : t("branchSettings.discountAdd")}</Btn>
                </div>
              </Card>
            </>
          )}

          {activeTab === "finance" && (
            <Card>
              <CardHeader icon="💰" title={t("branchSettings.financeTitle")} subtitle={t("branchSettings.financeSubtitle")} />
              <SettingRow label={t("branchSettings.bankAccountNumberLabel")} dbRef="branches.bank_account_number">
                <input value={bankAccountNumber} onChange={e => setBankAccountNumber(e.target.value)} style={inputStyle} />
              </SettingRow>
              <SettingRow label={t("branchSettings.bankAccountNameLabel")} dbRef="branches.bank_account_name">
                <input value={bankAccountName} onChange={e => setBankAccountName(e.target.value)} style={inputStyle} />
              </SettingRow>
              <SettingRow label={t("branchSettings.momoPayLabel")} dbRef="branches.momo_pay_number" last>
                <input value={momoPayNumber} onChange={e => setMomoPayNumber(e.target.value)} style={inputStyle} />
              </SettingRow>
            </Card>
          )}

          {activeTab === "alerts" && (
            <>
              <Card>
                <CardHeader icon="🔔" title={t("branchSettings.triggersTitle")} subtitle={t("branchSettings.triggersSubtitle")} />
                <SettingRow
                  label={t("branchSettings.triggerOutOfStockLabel")} description={t("branchSettings.reminderHoursHint")}
                  dbRef="notifications.source_type = 'out_of_stock'"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                    <input
                      type="number" min={1} max={168} value={reminderHours}
                      onChange={e => setReminderHours(Math.max(1, Math.min(168, Number(e.target.value) || 1)))}
                      style={{ ...inputStyle, width: 70 }}
                    />
                    <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.reminderHoursUnit")}</span>
                  </div>
                </SettingRow>
                <SettingRow
                  label={t("branchSettings.triggerStockAdjustmentLabel")} description={t("branchSettings.triggerStockAdjustmentHint")}
                  dbRef="notifications.source_type = 'stock_adjustment'"
                >
                  <AlwaysOnIndicator />
                </SettingRow>
                <SettingRow
                  label={t("branchSettings.triggerRequestApprovedLabel")} description={t("branchSettings.triggerRequestApprovedHint")}
                  dbRef="notifications.source_type = 'product_request_approved'"
                >
                  <AlwaysOnIndicator />
                </SettingRow>
                <SettingRow
                  label={t("branchSettings.triggerRequestRejectedLabel")} description={t("branchSettings.triggerRequestRejectedHint")}
                  dbRef="notifications.source_type = 'product_request_rejected'"
                >
                  <AlwaysOnIndicator />
                </SettingRow>
                <SettingRow
                  label={t("branchSettings.triggerLicenseExpiringLabel")} description={t("branchSettings.triggerLicenseExpiringHint")}
                  dbRef="notifications.source_type = 'license_expiring'" last
                >
                  <AlwaysOnIndicator />
                </SettingRow>
              </Card>

              <Card>
                <CardHeader icon="📬" title={t("branchSettings.deliveryTitle")} subtitle={t("branchSettings.deliverySubtitle")} />
                <SettingRow label={t("branchSettings.deliveryInAppLabel")} description={t("branchSettings.deliveryInAppHint")} last>
                  <AlwaysOnIndicator />
                </SettingRow>
              </Card>
            </>
          )}

          {activeTab === "users" && (
            <>
              <Card>
                <CardHeader icon="🔒" title={t("branchSettings.securityTitle")} subtitle={t("branchSettings.securitySubtitle")} />
                {passwordError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 10 }}>{passwordError}</p>}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.newPasswordLabel")}</label>
                    <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.confirmPasswordLabel")}</label>
                    <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} style={inputStyle} />
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                  <Btn variant="secondary" onClick={() => void changePassword()}>{changingPassword ? t("branchSettings.changingPassword") : t("branchSettings.changePassword")}</Btn>
                </div>
              </Card>

              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                  <CardHeader icon="👥" title={t("branchSettings.usersTitle")} subtitle={t("branchSettings.usersSubtitle", { count: staff.filter(m => m.isActive).length })} />
                  <Btn variant="primary" small onClick={() => setShowInvite(true)}>+ {t("branchSettings.inviteStaff")}</Btn>
                </div>
                {staffError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{staffError}</p>}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 20 }}>
                  {(["owner", "manager", "seller"] as BranchUserRole[]).map(role => (
                    <div key={role} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--bg)" }}>
                      <RoleBadge role={role} />
                      <p style={{ fontSize: 11, color: "var(--ink-muted)", margin: "8px 0 0", lineHeight: 1.5 }}>{t(ROLE_DESC_KEY[role])}</p>
                    </div>
                  ))}
                </div>

                <div>
                  {staffLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.loading")}</p> : staff.map((member, i) => (
                    <div key={member.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: i === staff.length - 1 ? "none" : "1px solid var(--bg-alt)", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <Avatar fullName={member.fullName} role={member.role} />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>
                            {member.fullName}
                            {!member.isActive && <span style={{ marginLeft: 8, fontSize: 11, color: "#dc2626", fontWeight: 600 }}>{t("branchSettings.inactiveLabel")}</span>}
                          </div>
                          <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{member.email ?? "—"}</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <RoleBadge role={member.role} />
                        {member.role !== "owner" && isOwner && (
                          <Btn variant="secondary" small onClick={() => setChangeRoleTarget(member)}>{t("branchSettings.changeRole")}</Btn>
                        )}
                        {member.role !== "owner" && (isOwner || member.role === "seller") && (
                          <Btn variant={member.isActive ? "danger" : "secondary"} small onClick={() => void toggleStaffActive(member)}>
                            {member.isActive ? t("branchSettings.deactivate") : t("branchSettings.activate")}
                          </Btn>
                        )}
                      </div>
                    </div>
                  ))}
                  {!staffLoading && staff.length === 0 && (
                    <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("branchSettings.usersEmpty")}</p>
                  )}
                </div>
              </Card>
            </>
          )}

          {activeTab === "categories" && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                <CardHeader icon="📁" title={t("branchSettings.categoriesTitle")} subtitle="product_categories" />
                <Btn variant="primary" small onClick={() => setShowAddCategory(true)}>+ {t("branchSettings.addCategory")}</Btn>
              </div>
              <div style={{ background: "var(--primary-light)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", fontSize: 12, color: "var(--ink-mid)", marginBottom: 18, lineHeight: 1.6 }}>
                {t("branchSettings.categoriesIntro")}
              </div>
              {categoriesError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{categoriesError}</p>}
              {categoriesLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.loading")}</p> : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
                  {categories.map((cat, i) => (
                    <div key={cat.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: CATEGORY_DOT_COLORS[i % CATEGORY_DOT_COLORS.length], flexShrink: 0 }} />
                          {cat.name}
                        </div>
                        <button onClick={() => setEditCategoryTarget(cat)} style={{ background: "none", border: "none", color: "var(--primary)", fontWeight: 600, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                          {t("branchSettings.editCategory")}
                        </button>
                      </div>
                      {cat.description && <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--ink-muted)" }}>{cat.description}</p>}
                      <p style={{ margin: 0, fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--font-mono)" }}>{cat.code}</p>
                    </div>
                  ))}
                  <button onClick={() => setShowAddCategory(true)} style={{
                    border: "1.5px dashed var(--border-strong)", borderRadius: 10, padding: 14, background: "none", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 12, fontFamily: "inherit", minHeight: 76,
                  }}>
                    + {t("branchSettings.newCategory")}
                  </button>
                </div>
              )}
            </Card>
          )}

          {activeTab === "storage" && <StorageLocationsManager />}

          {activeTab === "inventory" && (
            <Card>
              <CardHeader icon="📦" title={t("branchSettings.stockLevelsTitle")} subtitle={t("branchSettings.stockLevelsSubtitle")} />
              <SettingRow
                label={t("branchSettings.lowStockLabel")} description={t("branchSettings.lowStockHint")}
                dbRef="reorder_points.min_quantity comparison (Inventory Dashboard, Reports)"
              >
                <AlwaysOnIndicator />
              </SettingRow>
              <SettingRow
                label={t("branchSettings.expiryThresholdLabel")} description={t("branchSettings.expiryThresholdHint")}
                dbRef="branches.expiry_alert_threshold_days"
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                  <input
                    type="number" min={1} max={365} value={expiryAlertThresholdDays}
                    onChange={e => setExpiryAlertThresholdDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
                    style={{ ...inputStyle, width: 70 }}
                  />
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.daysUnit")}</span>
                </div>
              </SettingRow>
              <SettingRow
                label={t("branchSettings.defaultReorderMinLabel")} description={t("branchSettings.defaultReorderMinHint")}
                dbRef="branches.default_reorder_min" last
              >
                <input
                  type="number" min={0} value={defaultReorderMin}
                  onChange={e => setDefaultReorderMin(Math.max(0, Number(e.target.value) || 0))}
                  style={{ ...inputStyle, width: 90 }}
                />
              </SettingRow>
            </Card>
          )}
        </div>
      </div>
    )}

    {showInvite && (
      <InviteStaffModal
        onClose={() => setShowInvite(false)}
        onCreated={() => { setShowInvite(false); setSuccessMsg(t("branchSettings.usersInviteSuccess")); setSuccessSeq(seq => seq + 1); void refreshStaff() }}
        branchId={branchId}
        isOwner={isOwner}
      />
    )}
    {changeRoleTarget && (
      <ChangeRoleModal
        member={changeRoleTarget}
        onClose={() => setChangeRoleTarget(null)}
        onChanged={() => { setChangeRoleTarget(null); setSuccessMsg(t("branchSettings.usersRoleChangeSuccess")); setSuccessSeq(seq => seq + 1); void refreshStaff() }}
        branchId={branchId}
      />
    )}
    {showAddCategory && (
      <CategoryModal
        onClose={() => setShowAddCategory(false)}
        onSaved={async (name, description) => {
          await createBranchCategory(name, description, branchId)
          setShowAddCategory(false)
          setSuccessMsg(t("branchSettings.categoryAddSuccess"))
          setSuccessSeq(seq => seq + 1)
          void refreshCategories()
        }}
      />
    )}
    {editCategoryTarget && (
      <CategoryModal
        initial={editCategoryTarget}
        onClose={() => setEditCategoryTarget(null)}
        onSaved={async (name, description) => {
          await updateBranchCategory(editCategoryTarget.id, name, description, branchId)
          setEditCategoryTarget(null)
          setSuccessMsg(t("branchSettings.categorySaveSuccess"))
          setSuccessSeq(seq => seq + 1)
          void refreshCategories()
        }}
      />
    )}
  </div>
}
