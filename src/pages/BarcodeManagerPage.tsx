import { useCallback, useEffect, useMemo, useState } from "react"
import Barcode from "react-barcode"
import { Btn, Card, Modal, StatusBadge } from "../components"
import { fmtRWF } from "../data"
import {
  BARCODE_STATUSES,
  emptyBarcodeDataset,
  loadBarcodeDataset,
  type BarcodeDataset,
  type BarcodeRow,
  type BarcodeStatus,
  type BarcodeType,
} from "../lib/barcodes"
import { errorMessage } from "../lib/supabase"

const statusMeta: Record<BarcodeStatus, { label: string; color: string; background: string }> = {
  active: { label: "Active", color: "#16a34a", background: "#d1fae5" },
  sold_out: { label: "Sold out", color: "#475569", background: "#e2e8f0" },
  expired: { label: "Expired", color: "#9333ea", background: "#f5f3ff" },
  recalled: { label: "Recalled", color: "#dc2626", background: "#fef2f2" },
  damaged: { label: "Damaged", color: "#d97706", background: "#fef3c7" },
}

const typeMeta: Record<BarcodeType, { label: string; color: string; background: string }> = {
  box: { label: "Box / carton", color: "#0284c7", background: "#e0f2fe" },
  pack: { label: "Pack", color: "#1e8a4a", background: "#d1fae5" },
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div>
    <div style={{ fontSize: 10, color: "var(--ink-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
    <div style={{ fontSize: 12, color: "var(--ink)", marginTop: 2 }}>{value}</div>
  </div>
}

export default function BarcodeManagerPage() {
  const [dataset, setDataset] = useState<BarcodeDataset>(emptyBarcodeDataset)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<"all" | BarcodeStatus>("all")
  const [type, setType] = useState<"all" | BarcodeType>("all")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<BarcodeRow | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setDataset(await loadBarcodeDataset())
    } catch (reason) {
      setError(errorMessage(reason, "Unable to load barcode history from the database."))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (row: BarcodeRow) =>
      (!needle || row.haystack.includes(needle))
      && (status === "all" || row.status === status)
      && (type === "all" || row.barcode_type === type)
    return dataset.groups
      .map(group => ({ group, parentMatch: group.parent ? matches(group.parent) : false, children: group.children.filter(matches) }))
      .filter(entry => entry.parentMatch || entry.children.length > 0)
  }, [dataset.groups, query, status, type])

  const shownRows = visible.reduce((total, entry) => total + entry.children.length + (entry.parentMatch ? 1 : 0), 0)
  const parentOfSelected = selected?.parent_barcode_id
    ? dataset.rows.find(row => row.id === selected.parent_barcode_id) ?? null
    : null

  const toggle = (key: string) => setExpanded(current => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    {error && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>
      Could not load barcode history: {error}. Sign in with a provisioned pharmacy account and confirm its branch permissions, then try again.
    </div>}

    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
      {BARCODE_STATUSES.map(key => {
        const meta = statusMeta[key]
        const active = status === key
        return <button
          key={key}
          onClick={() => setStatus(active ? "all" : key)}
          style={{
            textAlign: "left", border: `1.5px solid ${active ? meta.color : "var(--border)"}`,
            background: active ? meta.background : "#fff", borderRadius: 10, padding: "12px 16px",
            cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
          }}
        >
          <div style={{ fontSize: 22, color: meta.color, fontWeight: 800 }}>{loading ? "—" : dataset.statusCounts[key]}</div>
          <div style={{ fontSize: 11, fontWeight: 600 }}>{meta.label}</div>
        </button>
      })}
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
      {[
        { label: "Carton (box) barcodes", value: dataset.boxCount, hint: "Parent rows — one per physical carton" },
        { label: "Pack barcodes", value: dataset.packCount, hint: "Leaf rows — loose pieces never get a barcode" },
        { label: "Pieces represented", value: dataset.totalPieces, hint: "Counted from pack rows only" },
      ].map(tile => <Card key={tile.label} style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "var(--primary)" }}>{loading ? "—" : tile.value.toLocaleString()}</div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>{tile.label}</div>
        <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{tile.hint}</div>
      </Card>)}
    </div>

    <Card>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>Barcode history</h2>
          <p style={{ margin: "3px 0 0", color: "var(--ink-muted)", fontSize: 11 }}>
            Live data from Supabase — no demo records are used on this screen. Barcodes are only created by the stock-receiving flow; this screen is read-only.
          </p>
        </div>
        <div style={{ display: "inline-flex", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 3 }}>
          {(["all", "box", "pack"] as const).map(option => <button
            key={option}
            onClick={() => setType(option)}
            style={{
              padding: "5px 11px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit",
              fontSize: 11, fontWeight: type === option ? 700 : 500,
              background: type === option ? "#fff" : "transparent",
              color: type === option ? "var(--primary)" : "var(--ink-muted)",
              boxShadow: type === option ? "0 1px 3px rgba(0,0,0,0.08)" : "none", transition: "all 0.15s",
            }}
          >{option === "all" ? "All types" : option === "box" ? "Boxes" : "Packs"}</button>)}
        </div>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search product, batch, delivery code, barcode…"
          style={{ width: 280, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12 }}
        />
        <Btn variant="secondary" small onClick={() => void refresh()}>Refresh</Btn>
      </div>

      <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 10 }}>
        {loading ? "Loading barcode history…" : `${shownRows.toLocaleString()} barcode${shownRows === 1 ? "" : "s"} in ${visible.length.toLocaleString()} group${visible.length === 1 ? "" : "s"}${status === "all" && type === "all" && !query.trim() ? "" : " matching the current filters"}.`}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {visible.map(({ group, parentMatch, children }) => {
          const isOpen = expanded.has(group.key)
          return <div key={group.key} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)" }}>
              <button
                onClick={() => toggle(group.key)}
                title={isOpen ? "Collapse" : "Expand"}
                style={{
                  width: 24, height: 24, borderRadius: 6, border: "1px solid var(--border-strong)", background: "#fff",
                  cursor: "pointer", color: "var(--ink-mid)", fontSize: 11, flexShrink: 0, fontFamily: "inherit",
                  transition: "transform 0.15s", transform: isOpen ? "rotate(90deg)" : "none",
                }}
              >▶</button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
                  {group.productName}
                  {group.variantLabel && <span style={{ fontWeight: 400, color: "var(--ink-muted)" }}> · {group.variantLabel}</span>}
                </div>
                <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>
                  Batch <span style={{ fontFamily: "JetBrains Mono, monospace" }}>{group.batchNumber}</span>
                  {group.deliveryCode && <> · Delivery <span style={{ fontFamily: "JetBrains Mono, monospace" }}>{group.deliveryCode}</span></>}
                  {" · "}{group.supplierName} · Expires {group.expiryDate}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <StatusBadge
                  label={group.kind === "carton" ? `Carton → ${group.children.length} pack${group.children.length === 1 ? "" : "s"}` : `${group.children.length} loose pack${group.children.length === 1 ? "" : "s"}`}
                  color={group.kind === "carton" ? typeMeta.box.color : typeMeta.pack.color}
                  bg={group.kind === "carton" ? typeMeta.box.background : typeMeta.pack.background}
                />
                {group.statuses.map(entry => <StatusBadge key={entry} label={statusMeta[entry].label} color={statusMeta[entry].color} bg={statusMeta[entry].background} />)}
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink)" }}>{group.pieces.toLocaleString()} pcs</span>
              </div>
            </div>

            {group.parent && <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px 8px 46px", borderTop: "1px solid var(--border)", opacity: parentMatch ? 1 : 0.5 }}>
              <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 700, color: "var(--ink)" }}>{group.parent.code}</span>
              <StatusBadge label={typeMeta.box.label} color={typeMeta.box.color} bg={typeMeta.box.background} />
              <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>holds {group.parent.child_count ?? 0} packs · {group.parent.code_source}</span>
              <div style={{ flex: 1 }} />
              <StatusBadge label={statusMeta[group.parent.status].label} color={statusMeta[group.parent.status].color} bg={statusMeta[group.parent.status].background} />
              <Btn variant="ghost" small onClick={() => setSelected(group.parent)}>View</Btn>
            </div>}

            {isOpen && <div style={{ borderTop: "1px solid var(--border)" }}>
              {children.map(child => <div
                key={child.id}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: group.kind === "carton" ? "7px 12px 7px 62px" : "7px 12px 7px 46px",
                  borderBottom: "1px solid var(--bg-alt)",
                }}
              >
                {group.kind === "carton" && <span style={{ color: "var(--border-strong)", fontSize: 11 }}>└</span>}
                <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--ink)" }}>{child.code}</span>
                <StatusBadge label={typeMeta.pack.label} color={typeMeta.pack.color} bg={typeMeta.pack.background} />
                <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>{child.pieces_per_pack ?? 0} pieces/pack · {child.quantity_available} available · {fmtRWF(child.selling_price)}</span>
                <div style={{ flex: 1 }} />
                <StatusBadge label={statusMeta[child.status].label} color={statusMeta[child.status].color} bg={statusMeta[child.status].background} />
                <Btn variant="ghost" small onClick={() => setSelected(child)}>View</Btn>
              </div>)}
              {children.length === 0 && <div style={{ padding: "12px 46px", fontSize: 11, color: "var(--ink-muted)" }}>
                No child barcodes in this group match the current filters.
              </div>}
            </div>}
          </div>
        })}

        {!loading && visible.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>
          {dataset.rows.length === 0
            ? "No barcodes exist for this branch yet. Receive a delivery on the Stock Receiving screen and the server will generate the carton and pack barcodes."
            : "No barcode matches the current search or filters."}
        </div>}
      </div>
    </Card>

    {selected && <Modal title={`Barcode ${selected.code}`} onClose={() => setSelected(null)} width={560}>
      <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 10, padding: 14, display: "flex", justifyContent: "center", overflowX: "auto" }}>
        <Barcode value={selected.code} format="CODE128" height={62} width={1.3} fontSize={11} background="#ffffff" lineColor="#0c1e12" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginTop: 16 }}>
        <Detail label="Type" value={typeMeta[selected.barcode_type].label} />
        <Detail label="Status" value={statusMeta[selected.status].label} />
        <Detail label="Product" value={[selected.product_name, selected.variant_label].filter(Boolean).join(" · ")} />
        <Detail label="Generic name" value={selected.generic_name ?? "—"} />
        <Detail label="Batch number" value={selected.batch_number} />
        <Detail label="Expiry date" value={selected.expiry_date} />
        <Detail label="Delivery code" value={selected.delivery_code ?? "—"} />
        <Detail label="Supplier" value={selected.supplier_name} />
        <Detail label="Manufacturer" value={selected.manufacturer_name ?? "—"} />
        <Detail label="Code source" value={selected.code_source} />
        <Detail
          label={selected.barcode_type === "box" ? "Packs inside" : "Pieces per pack"}
          value={String(selected.barcode_type === "box" ? selected.child_count ?? 0 : selected.pieces_per_pack ?? 0)}
        />
        <Detail label="Quantity available" value={selected.quantity_available.toLocaleString()} />
        <Detail label="Parent carton" value={parentOfSelected ? parentOfSelected.code : selected.barcode_type === "pack" ? "None — loose pack" : "None — this is the parent"} />
        <Detail label="Created" value={new Date(selected.created_at).toLocaleString()} />
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 14, marginBottom: 0 }}>
        Individual pieces are never barcoded. Stock is counted from pack barcodes only: quantity available × pieces per pack.
      </p>
    </Modal>}
  </div>
}
