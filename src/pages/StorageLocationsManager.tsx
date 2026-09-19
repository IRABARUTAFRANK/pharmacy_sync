import { useCallback, useEffect, useState } from "react"
import { Btn, Card, CardHeader, CATEGORY_DOT_COLORS, inputStyle, SearchSelect, type ComboOption } from "../components"
import { useTranslation } from "../lib/i18n"
import { errorMessage } from "../lib/supabase"
import {
  createStorageLocation, deleteStorageLocation, listBranchProductsForLocationPicker, listStorageLocations,
  renameStorageLocation, setProductStorageLocation, type LocationPickerProduct, type StorageLocation,
} from "../lib/storageLocations"

// The full "create a location, assign products to it" management UI --
// originally the Storage Locations tab in Branch Settings (owner/manager
// only, gated by that page's own tab visibility), now also embedded
// directly in the sidebar Locate Product page for owner/manager so they
// don't have to leave that page to reorganize locations while looking
// something up. LocateProductPage's own read-only search stays available
// to every role (sellers included); this component is the create/assign
// half, rendered only for callers who already know they may use it.
export default function StorageLocationsManager() {
  const { t } = useTranslation()
  const [storageLocations, setStorageLocations] = useState<StorageLocation[]>([])
  const [storageLoading, setStorageLoading] = useState(true)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [newLocationName, setNewLocationName] = useState("")
  const [creatingLocation, setCreatingLocation] = useState(false)
  const [locationDetail, setLocationDetail] = useState<StorageLocation | null>(null)
  const [locationProducts, setLocationProducts] = useState<LocationPickerProduct[]>([])
  const [locationProductsLoading, setLocationProductsLoading] = useState(false)
  const [assignPick, setAssignPick] = useState("")

  const refreshStorageLocations = useCallback(async () => {
    setStorageLoading(true)
    setStorageError(null)
    try {
      setStorageLocations(await listStorageLocations())
    } catch (reason) {
      setStorageError(errorMessage(reason, t("branchSettings.storageLoadError")))
    } finally {
      setStorageLoading(false)
    }
  }, [t])

  useEffect(() => { void refreshStorageLocations() }, [refreshStorageLocations])

  // The full per-branch product+location list is fetched once and reused
  // for both "which products are at this location" (filtered client-side)
  // and the "assign a product" dropdown -- a location almost never has
  // more than a modest number of stocked products, so one list beats a
  // second RPC just to scope it server-side. This is also "products in
  // stock at this branch" -- list_branch_products_for_location_picker()
  // covers every product ever received here, not just this location.
  const loadLocationProducts = useCallback(async () => {
    setLocationProductsLoading(true)
    try {
      setLocationProducts(await listBranchProductsForLocationPicker())
    } catch (reason) {
      setStorageError(errorMessage(reason, t("branchSettings.storageLoadError")))
    } finally {
      setLocationProductsLoading(false)
    }
  }, [t])

  async function createLocation() {
    if (!newLocationName.trim()) return
    setCreatingLocation(true)
    setStorageError(null)
    try {
      await createStorageLocation(newLocationName.trim())
      setNewLocationName("")
      await refreshStorageLocations()
    } catch (reason) {
      setStorageError(errorMessage(reason, t("branchSettings.storageCreateError")))
    } finally {
      setCreatingLocation(false)
    }
  }

  async function openLocationDetail(loc: StorageLocation) {
    setLocationDetail(loc)
    setAssignPick("")
    await loadLocationProducts()
  }

  async function assignProductToLocation(productId: string) {
    if (!locationDetail) return
    try {
      await setProductStorageLocation(productId, locationDetail.id)
      await Promise.all([loadLocationProducts(), refreshStorageLocations()])
    } catch (reason) {
      setStorageError(errorMessage(reason, t("branchSettings.storageAssignError")))
    }
  }

  async function unassignProduct(productId: string) {
    try {
      await setProductStorageLocation(productId, null)
      await Promise.all([loadLocationProducts(), refreshStorageLocations()])
    } catch (reason) {
      setStorageError(errorMessage(reason, t("branchSettings.storageAssignError")))
    }
  }

  async function renameLocation(loc: StorageLocation, name: string) {
    if (!name.trim()) return
    try {
      await renameStorageLocation(loc.id, name.trim())
      await refreshStorageLocations()
      setLocationDetail(prev => prev && prev.id === loc.id ? { ...prev, name: name.trim() } : prev)
    } catch (reason) {
      setStorageError(errorMessage(reason, t("branchSettings.storageRenameError")))
    }
  }

  async function removeLocation(loc: StorageLocation) {
    try {
      await deleteStorageLocation(loc.id)
      setLocationDetail(prev => prev && prev.id === loc.id ? null : prev)
      await refreshStorageLocations()
    } catch (reason) {
      setStorageError(errorMessage(reason, t("branchSettings.storageDeleteError")))
    }
  }

  const assignOptions: ComboOption[] = locationDetail
    ? locationProducts
        .filter(p => p.storageLocationId !== locationDetail.id)
        .map(p => ({
          value: p.productId,
          label: p.productName,
          hint: p.storageLocationName ? t("branchSettings.storageCurrentlyAt", { name: p.storageLocationName }) : undefined,
        }))
    : []

  return (
    <Card>
      {locationDetail ? (
        <>
          <button onClick={() => setLocationDetail(null)} style={{ background: "none", border: "none", color: "var(--primary)", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit", marginBottom: 12, padding: 0 }}>
            ← {t("branchSettings.storageBackToList")}
          </button>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
            <CardHeader icon="🗄️" title={locationDetail.name} subtitle={t("branchSettings.storageProductCount", { count: locationDetail.productCount })} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { const name = window.prompt(t("branchSettings.storageRenamePrompt"), locationDetail.name); if (name) void renameLocation(locationDetail, name) }}
                style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px", color: "var(--ink-mid)", fontWeight: 600, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                {t("branchSettings.storageRename")}
              </button>
              <button onClick={() => { if (window.confirm(t("branchSettings.storageDeleteConfirm", { name: locationDetail.name }))) void removeLocation(locationDetail) }}
                style={{ background: "none", border: "1px solid #fca5a5", borderRadius: 8, padding: "6px 12px", color: "#dc2626", fontWeight: 600, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                {t("branchSettings.storageDelete")}
              </button>
            </div>
          </div>

          {storageError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{storageError}</p>}

          <div style={{ marginBottom: 18 }}>
            <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>
              {t("branchSettings.storageAssignLabel")}
            </label>
            <SearchSelect
              options={assignOptions}
              value={assignPick}
              onSelect={id => { if (id) void assignProductToLocation(id); setAssignPick("") }}
              placeholder={t("branchSettings.storageSearchPlaceholder")}
              emptyMessage={t("branchSettings.storageEmpty")}
            />
          </div>

          {locationProductsLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.loading")}</p> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {locationProducts.filter(p => p.storageLocationId === locationDetail.id).map(p => (
                <div key={p.productId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "var(--bg)", borderRadius: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{p.productName}</span>
                  <button onClick={() => void unassignProduct(p.productId)} style={{ background: "none", border: "none", color: "var(--ink-faint)", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                    {t("branchSettings.storageRemove")}
                  </button>
                </div>
              ))}
              {locationProducts.filter(p => p.storageLocationId === locationDetail.id).length === 0 && (
                <p style={{ fontSize: 12, color: "var(--ink-muted)", margin: 0 }}>{t("branchSettings.storageEmpty")}</p>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <CardHeader icon="🗄️" title={t("branchSettings.tabStorage")} subtitle="storage_locations" />
          <div style={{ background: "var(--primary-light)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", fontSize: 12, color: "var(--ink-mid)", marginBottom: 18, lineHeight: 1.6 }}>
            {t("branchSettings.storageIntro")}
          </div>
          {storageError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{storageError}</p>}
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input value={newLocationName} onChange={e => setNewLocationName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void createLocation() } }}
              placeholder={t("branchSettings.storageNewPlaceholder")} style={{ ...inputStyle, flex: 1 }} />
            <Btn variant="primary" onClick={() => void createLocation()}>
              {creatingLocation ? t("branchSettings.storageCreating") : `+ ${t("branchSettings.storageAdd")}`}
            </Btn>
          </div>
          {storageLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.loading")}</p> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
              {storageLocations.map((loc, i) => (
                <button key={loc.id} onClick={() => void openLocationDetail(loc)} style={{
                  border: "1px solid var(--border)", borderRadius: 10, padding: 14, textAlign: "left", background: "var(--surface)", cursor: "pointer", fontFamily: "inherit",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 13, color: "var(--ink)", marginBottom: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: CATEGORY_DOT_COLORS[i % CATEGORY_DOT_COLORS.length], flexShrink: 0 }} />
                    {loc.name}
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("branchSettings.storageProductCount", { count: loc.productCount })}</p>
                </button>
              ))}
              {storageLocations.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--ink-muted)", margin: 0 }}>{t("branchSettings.storageEmpty")}</p>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
