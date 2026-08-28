import { useCallback, useEffect, useMemo, useState } from "react"
import Barcode from "react-barcode"
import { Btn, Card, Modal, StatusBadge, BarcodeLabelSheet, type PrintableBarcode } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { useGlobalSearch } from "../lib/search"
import {
  BARCODE_STATUSES,
  BARCODE_STATUS_TITLE_KEYS,
  BARCODE_TYPE_TITLE_KEYS,
  emptyBarcodeDataset,
  loadBarcodeDataset,
  type BarcodeDataset,
  type BarcodeGroup,
  type BarcodeRow,
  type BarcodeStatus,
  type BarcodeType,
} from "../lib/barcodes"
import { errorMessage } from "../lib/supabase"

function toPrintable(row: BarcodeRow): PrintableBarcode {
  return {
    id: row.id, code: row.code, barcode_type: row.barcode_type,
    product_name: row.product_name, variant_label: row.variant_label,
    child_count: row.child_count, pieces_per_pack: row.pieces_per_pack,
    price: row.selling_price,
  }
}

function groupToPrintable(group: BarcodeGroup): PrintableBarcode[] {
  return [...(group.parent ? [group.parent] : []), ...group.children].map(toPrintable)
}

const statusColor: Record<BarcodeStatus, { color: string; background: string }> = {
  active: { color: "#16a34a", background: "#d1fae5" },
  sold_out: { color: "#475569", background: "#e2e8f0" },
  expired: { color: "#9333ea", background: "#f5f3ff" },
  recalled: { color: "#dc2626", background: "#fef2f2" },
  damaged: { color: "#d97706", background: "#fef3c7" },
}

const typeColor: Record<BarcodeType, { color: string; background: string }> = {
  box: { color: "#0284c7", background: "#e0f2fe" },
  pack: { color: "#1e5fa8", background: "#d1fae5" },
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div>
    <div style={{ fontSize: 10, color: "var(--ink-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
    <div style={{ fontSize: 12, color: "var(--ink)", marginTop: 2 }}>{value}</div>
  </div>
}

export default function BarcodeManagerPage() {
  const { t } = useTranslation()
  const statusLabel = (s: BarcodeStatus) => t(BARCODE_STATUS_TITLE_KEYS[s])
  const typeLabel = (ty: BarcodeType) => t(BARCODE_TYPE_TITLE_KEYS[ty])

  const [dataset, setDataset] = useState<BarcodeDataset>(emptyBarcodeDataset)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { term: globalTerm, setTerm: setGlobalTerm } = useGlobalSearch()
  const [query, setQuery] = useState(globalTerm)
  useEffect(() => setQuery(globalTerm), [globalTerm])
  const [status, setStatus] = useState<"all" | BarcodeStatus>("all")
  const [type, setType] = useState<"all" | BarcodeType>("all")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<BarcodeRow | null>(null)
  const [printJob, setPrintJob] = useState<{ title: string; labels: PrintableBarcode[] } | null>(null)
  const [printDeliveryCode, setPrintDeliveryCode] = useState("")

  // A "Print" click should feel like one action, not "click Print, notice a
  // sheet appeared below, click a second Print button" -- so the browser's
  // print dialog opens itself as soon as the sheet has actually rendered
  // (rAF, so it's after the DOM update from setPrintJob above lands).
  useEffect(() => {
    if (!printJob) return
    const id = requestAnimationFrame(() => window.print())
    return () => cancelAnimationFrame(id)
  }, [printJob])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setDataset(await loadBarcodeDataset())
    } catch (reason) {
      setError(errorMessage(reason, t("barcodeManager.loadError")))
    } finally {
      setLoading(false)
    }
  }, [t])

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

  const deliveryCodes = useMemo(
    () => Array.from(new Set(dataset.rows.map(row => row.delivery_code).filter((code): code is string => !!code))).sort(),
    [dataset.rows],
  )

  function printDelivery() {
    if (!printDeliveryCode) return
    const labels = dataset.rows.filter(row => row.delivery_code === printDeliveryCode).map(toPrintable)
    setPrintJob({ title: t("barcodeManager.printDeliveryTitle", { code: printDeliveryCode }), labels })
  }

  const toggle = (key: string) => setExpanded(current => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    {error && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>
      {t("barcodeManager.loadErrorPrefix")}: {error}. {t("barcodeManager.loadErrorHint")}
    </div>}

    <div style={{ background: "var(--primary-light)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span style={{ fontSize: 18, flexShrink: 0 }}>📦</span>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{t("reports.packagingExplainerTitle")}</div>
        <div style={{ fontSize: 11, color: "var(--ink-mid)", marginTop: 3, lineHeight: 1.5 }}>{t("barcodeManager.packagingExplainerBody")}</div>
      </div>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
      {BARCODE_STATUSES.map((key, i) => {
        const meta = statusColor[key]
        const active = status === key
        return <button
          key={key}
          onClick={() => setStatus(active ? "all" : key)}
          className="animate-fade-up"
          style={{
            animationDelay: `${i * 50}ms`,
            textAlign: "left", border: `1.5px solid ${active ? meta.color : "var(--border)"}`,
            background: active ? meta.background : "#fff", borderRadius: 10, padding: "12px 16px",
            cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
          }}
        >
          <div style={{ fontSize: 22, color: meta.color, fontWeight: 800 }}>{loading ? "—" : dataset.statusCounts[key]}</div>
          <div style={{ fontSize: 11, fontWeight: 600 }}>{statusLabel(key)}</div>
        </button>
      })}
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
      {[
        { label: t("barcodeManager.tileCartons"), value: dataset.boxCount, hint: t("barcodeManager.tileCartonsHint") },
        { label: t("barcodeManager.tilePacks"), value: dataset.packCount, hint: t("barcodeManager.tilePacksHint") },
        { label: t("barcodeManager.tilePieces"), value: dataset.totalPieces, hint: t("barcodeManager.tilePiecesHint") },
      ].map(tile => <Card key={tile.label} style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "var(--primary)" }}>{loading ? "—" : tile.value.toLocaleString()}</div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>{tile.label}</div>
        <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{tile.hint}</div>
      </Card>)}
    </div>

    <Card>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>{t("barcodeManager.historyTitle")}</h2>
          <p style={{ margin: "3px 0 0", color: "var(--ink-muted)", fontSize: 11 }}>
            {t("barcodeManager.historySubtitle")}
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
          >{option === "all" ? t("barcodeManager.allTypes") : option === "box" ? t("barcodeManager.boxes") : t("barcodeManager.packs")}</button>)}
        </div>
        <input
          value={query}
          onChange={event => { setQuery(event.target.value); setGlobalTerm(event.target.value) }}
          placeholder={t("barcodeManager.searchPlaceholder")}
          style={{ width: 280, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12 }}
        />
        <Btn variant="secondary" small onClick={() => void refresh()}>{t("barcodeManager.refresh")}</Btn>
      </div>

      <div className="no-print" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-mid)" }}>🖨 {t("barcodeManager.printDeliveryLabel")}</span>
        <select
          value={printDeliveryCode}
          onChange={event => setPrintDeliveryCode(event.target.value)}
          style={{ padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 6, fontFamily: "inherit", fontSize: 11, background: "#fff" }}
        >
          <option value="">{t("barcodeManager.selectDelivery")}</option>
          {deliveryCodes.map(code => <option key={code} value={code}>{code}</option>)}
        </select>
        <Btn variant="secondary" small onClick={printDelivery} style={printDeliveryCode ? {} : { opacity: 0.5, cursor: "not-allowed", pointerEvents: "none" }}>{t("barcodeManager.printAllBarcodes")}</Btn>
      </div>

      <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 10 }}>
        {loading ? t("barcodeManager.loadingHistory") : t(
          status === "all" && type === "all" && !query.trim() ? "barcodeManager.summaryPlain" : "barcodeManager.summaryFiltered",
          { rows: shownRows.toLocaleString(), groups: visible.length.toLocaleString() },
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {visible.map(({ group, parentMatch, children }) => {
          const isOpen = expanded.has(group.key)
          return <div key={group.key} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)" }}>
              <button
                onClick={() => toggle(group.key)}
                title={isOpen ? t("barcodeManager.collapse") : t("barcodeManager.expand")}
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
                  {t("barcodeManager.batchLabel")} <span style={{ fontFamily: "var(--font-mono)" }}>{group.batchNumber}</span>
                  {group.deliveryCode && <> · {t("barcodeManager.deliveryLabel")} <span style={{ fontFamily: "var(--font-mono)" }}>{group.deliveryCode}</span></>}
                  {" · "}{group.supplierName} · {t("barcodeManager.expiresLabel")} {group.expiryDate}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <StatusBadge
                  label={group.kind === "carton" ? t("barcodeManager.cartonContains", { count: group.children.length }) : t("barcodeManager.loosePacks", { count: group.children.length })}
                  color={group.kind === "carton" ? typeColor.box.color : typeColor.pack.color}
                  bg={group.kind === "carton" ? typeColor.box.background : typeColor.pack.background}
                />
                {group.statuses.map(entry => <StatusBadge key={entry} label={statusLabel(entry)} color={statusColor[entry].color} bg={statusColor[entry].background} />)}
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink)" }}>{t("barcodeManager.piecesCount", { count: group.pieces.toLocaleString() })}</span>
                <Btn variant="secondary" small onClick={() => setPrintJob({ title: t("barcodeManager.printGroupTitle", { product: group.productName, batch: group.batchNumber }), labels: groupToPrintable(group) })}>🖨 {t("barcodeManager.printGroup")}</Btn>
              </div>
            </div>

            {group.parent && <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px 8px 46px", borderTop: "1px solid var(--border)", opacity: parentMatch ? 1 : 0.5 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--ink)" }}>{group.parent.code}</span>
              <StatusBadge label={typeLabel("box")} color={typeColor.box.color} bg={typeColor.box.background} />
              <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>{t("barcodeManager.holdsPacks", { count: group.parent.child_count ?? 0 })} · {group.parent.code_source}</span>
              <div style={{ flex: 1 }} />
              <StatusBadge label={statusLabel(group.parent.status)} color={statusColor[group.parent.status].color} bg={statusColor[group.parent.status].background} />
              <Btn variant="ghost" small onClick={() => setPrintJob({ title: t("barcodeManager.printCartonTitle", { code: group.parent!.code }), labels: groupToPrintable(group) })}>{t("barcodeManager.printCartonAction")}</Btn>
              <Btn variant="ghost" small onClick={() => setSelected(group.parent)}>{t("barcodeManager.view")}</Btn>
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
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink)" }}>{child.code}</span>
                <StatusBadge label={typeLabel("pack")} color={typeColor.pack.color} bg={typeColor.pack.background} />
                <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>{t("barcodeManager.piecesPerPack", { count: child.pieces_per_pack ?? 0 })} · {t("barcodeManager.availableCount", { count: child.quantity_available })} · {t("barcodeManager.sellPrefix")}: {fmtRWFExact(child.selling_price)}</span>
                <div style={{ flex: 1 }} />
                <StatusBadge label={statusLabel(child.status)} color={statusColor[child.status].color} bg={statusColor[child.status].background} />
                <Btn variant="ghost" small onClick={() => setPrintJob({ title: t("barcodeManager.printBarcodeTitle", { code: child.code }), labels: [toPrintable(child)] })}>{t("barcodeManager.print")}</Btn>
                <Btn variant="ghost" small onClick={() => setSelected(child)}>{t("barcodeManager.view")}</Btn>
              </div>)}
              {children.length === 0 && <div style={{ padding: "12px 46px", fontSize: 11, color: "var(--ink-muted)" }}>
                {t("barcodeManager.noChildMatches")}
              </div>}
            </div>}
          </div>
        })}

        {!loading && visible.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>
          {dataset.rows.length === 0 ? t("barcodeManager.emptyNone") : t("barcodeManager.emptyFiltered")}
        </div>}
      </div>
    </Card>

    {selected && <Modal title={t("barcodeManager.detailTitle", { code: selected.code })} onClose={() => setSelected(null)} width={560}>
      <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 10, padding: 14, display: "flex", justifyContent: "center", overflowX: "auto" }}>
        <Barcode value={selected.code} format="CODE128" height={62} width={1.3} fontSize={11} background="#ffffff" lineColor="#0c1e12" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginTop: 16 }}>
        <Detail label={t("barcodeManager.detailType")} value={typeLabel(selected.barcode_type)} />
        <Detail label={t("barcodeManager.detailStatus")} value={statusLabel(selected.status)} />
        <Detail label={t("barcodeManager.detailProduct")} value={[selected.product_name, selected.variant_label].filter(Boolean).join(" · ")} />
        <Detail label={t("barcodeManager.detailGenericName")} value={selected.generic_name ?? "—"} />
        <Detail label={t("barcodeManager.detailBatchNumber")} value={selected.batch_number} />
        <Detail label={t("barcodeManager.detailExpiryDate")} value={selected.expiry_date} />
        <Detail label={t("barcodeManager.detailDeliveryCode")} value={selected.delivery_code ?? "—"} />
        <Detail label={t("barcodeManager.detailSupplier")} value={selected.supplier_name} />
        <Detail label={t("barcodeManager.detailManufacturer")} value={selected.manufacturer_name ?? "—"} />
        <Detail label={t("barcodeManager.detailCodeSource")} value={selected.code_source} />
        <Detail label={t("barcodeManager.detailCostPrice")} value={fmtRWFExact(selected.cost_price)} />
        <Detail label={t("barcodeManager.detailSellingPrice")} value={fmtRWFExact(selected.selling_price)} />
        <Detail
          label={selected.barcode_type === "box" ? t("barcodeManager.detailPacksInside") : t("barcodeManager.detailPiecesPerPack")}
          value={String(selected.barcode_type === "box" ? selected.child_count ?? 0 : selected.pieces_per_pack ?? 0)}
        />
        <Detail label={t("barcodeManager.detailQuantityAvailable")} value={selected.quantity_available.toLocaleString()} />
        <Detail label={t("barcodeManager.detailParentCarton")} value={parentOfSelected ? parentOfSelected.code : selected.barcode_type === "pack" ? t("barcodeManager.detailParentNoneLoose") : t("barcodeManager.detailParentNoneRoot")} />
        <Detail label={t("barcodeManager.detailCreated")} value={new Date(selected.created_at).toLocaleString()} />
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 14, marginBottom: 0 }}>
        {t("barcodeManager.detailFooterNote")}
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <Btn variant="primary" small onClick={() => { setPrintJob({ title: t("barcodeManager.printBarcodeTitle", { code: selected.code }), labels: [toPrintable(selected)] }); setSelected(null) }}>🖨 {t("barcodeManager.printThisBarcode")}</Btn>
      </div>
    </Modal>}

    {printJob && (
      <div style={{ marginTop: 4 }}>
        <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
          <button onClick={() => setPrintJob(null)} style={{ fontSize: 11, color: "var(--ink-muted)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>{t("barcodeManager.closePreview")}</button>
        </div>
        <BarcodeLabelSheet title={printJob.title} labels={printJob.labels} />
      </div>
    )}
  </div>
}
