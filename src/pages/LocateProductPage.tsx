import { useEffect, useMemo, useState } from "react"
import { Card, SectionHeader } from "../components"
import { useTranslation } from "../lib/i18n"
import { errorMessage } from "../lib/supabase"
import { listBranchProductsForLocationPicker, type LocationPickerProduct } from "../lib/storageLocations"
import type { Role } from "../data"
import StorageLocationsManager from "./StorageLocationsManager"

// A dedicated, sidebar-level page any signed-in staff member (including a
// plain seller, who has no access to Branch Settings at all) can reach when
// a customer wants a product and they need to know exactly where it's kept.
// Sellers only ever see the read-only "Search" tab below. An owner/manager
// additionally gets a "Manage locations" tab -- the exact same create-
// locations/assign-products functionality as the Storage Locations tab in
// Branch Settings (StorageLocationsManager is shared between both places),
// so they don't have to leave this page to reorganize things while looking
// something up. If the branch never set up storage locations at all, the
// Search tab just shows every product as "Location not set" -- still
// useful (confirms the product exists at this branch), never an error or
// an empty/broken state.
export default function LocateProductPage({ role }: { role: Role }) {
  const { t } = useTranslation()
  const canManage = role === "owner" || role === "manager"
  const [tab, setTab] = useState<"search" | "manage">("search")
  const [products, setProducts] = useState<LocationPickerProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  useEffect(() => {
    if (tab !== "search") return
    listBranchProductsForLocationPicker()
      .then(setProducts)
      .catch(reason => setError(errorMessage(reason, t("locateProductPage.loadError"))))
      .finally(() => setLoading(false))
  }, [t, tab])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return products
    return products.filter(p =>
      p.productName.toLowerCase().includes(needle) ||
      (p.genericName ?? "").toLowerCase().includes(needle) ||
      (p.storageLocationName ?? "").toLowerCase().includes(needle)
    )
  }, [products, query])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SectionHeader title={t("locateProductPage.title")} subtitle={t("locateProductPage.subtitle")} />

      {canManage && (
        <div style={{ display: "flex", gap: 8 }}>
          {(["search", "manage"] as const).map(id => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                padding: "8px 16px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                border: `1.5px solid ${tab === id ? "var(--primary)" : "var(--border)"}`,
                background: tab === id ? "var(--primary-light)" : "var(--surface)",
                color: tab === id ? "var(--primary)" : "var(--ink-mid)",
              }}
            >
              {id === "search" ? t("locateProductPage.tabSearch") : t("locateProductPage.tabManage")}
            </button>
          ))}
        </div>
      )}

      {tab === "manage" && canManage ? (
        <StorageLocationsManager />
      ) : (
        <Card>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("locateProductPage.searchPlaceholder")}
            autoFocus
            style={{
              width: "100%", padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 10,
              fontFamily: "inherit", fontSize: 14, boxSizing: "border-box", marginBottom: 14,
            }}
          />
          {error && <p style={{ margin: "0 0 12px", fontSize: 12, color: "#dc2626" }}>{error}</p>}
          {loading ? (
            <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("locateProductPage.loading")}</p>
          ) : filtered.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-muted)", textAlign: "center", padding: "24px 0" }}>
              {products.length === 0 ? t("locateProductPage.empty") : t("locateProductPage.noMatches")}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "60vh", overflowY: "auto" }}>
              {filtered.map(p => (
                <div key={p.productId} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
                  padding: "10px 12px", background: "var(--bg)", borderRadius: 8,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>{p.productName}</div>
                    {p.genericName && <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{p.genericName}</div>}
                  </div>
                  {p.storageLocationName ? (
                    <span style={{
                      flexShrink: 0, fontSize: 12, fontWeight: 700, color: "var(--primary)",
                      background: "var(--primary-light)", padding: "5px 12px", borderRadius: 999,
                    }}>
                      📍 {p.storageLocationName}
                    </span>
                  ) : (
                    <span style={{ flexShrink: 0, fontSize: 11, color: "var(--ink-faint)" }}>{t("locateProductPage.notSet")}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
