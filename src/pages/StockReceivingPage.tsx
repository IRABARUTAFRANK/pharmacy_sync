import { useMemo, useState, type CSSProperties } from "react"
import { dbProductCategories, dbProductVariants, dbProducts, dbSuppliers } from "../data"

type Packaging = "simple" | "cartons"

export default function StockReceivingPage() {
  const [supplierId, setSupplierId] = useState(dbSuppliers[0]?.id ?? "")
  const [category, setCategory] = useState(dbProductCategories[0]?.name ?? "")
  const [newCategory, setNewCategory] = useState("")
  const [manufacturer, setManufacturer] = useState("")
  const [costPrice, setCostPrice] = useState("")
  const [sellingPrice, setSellingPrice] = useState("")
  const [variantId, setVariantId] = useState(dbProductVariants[0]?.id ?? "")
  const [batch, setBatch] = useState("")
  const [expiry, setExpiry] = useState("")
  const [packaging, setPackaging] = useState<Packaging>("cartons")
  const [cartons, setCartons] = useState(2)
  const [packs, setPacks] = useState(10)
  const [pieces, setPieces] = useState(10)
  const [saved, setSaved] = useState(false)
  const variant = dbProductVariants.find(item => item.id === variantId)
  const product = dbProducts.find(item => item.id === variant?.product_id)
  const totalPieces = packaging === "cartons" ? cartons * packs * pieces : packs * pieces
  const preview = useMemo(() => {
    const prefix = "PENDING"
    return packaging === "cartons"
      ? Array.from({ length: cartons }, (_, carton) => ({ carton: `PS-${prefix}-C${String(carton + 1).padStart(2, "0")}`, packs: Array.from({ length: packs }, (_, pack) => `PS-${prefix}-C${String(carton + 1).padStart(2, "0")}-P${String(pack + 1).padStart(2, "0")}`) }))
      : [{ carton: "", packs: Array.from({ length: packs }, (_, pack) => `PS-${prefix}-P${String(pack + 1).padStart(3, "0")}`) }]
  }, [cartons, packaging, packs])
  const input: CSSProperties = { width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, font: "inherit", boxSizing: "border-box" }

  return <div style={{ maxWidth: 1060, margin: "0 auto", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 16 }}>
    <section style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
      <h1 style={{ margin: 0, fontSize: 18 }}>Receive delivery</h1><p style={{ color: "var(--ink-muted)", margin: "5px 0 18px", fontSize: 12 }}>One delivery code groups all supplier items; every product/batch becomes its own stock batch.</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label>Supplier<select value={supplierId} onChange={e => setSupplierId(e.target.value)} style={input}>{dbSuppliers.map(s => <option key={s.id} value={s.id}>{s.supplier_name}</option>)}</select></label>
        <div style={{ padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)", fontSize: 12 }}><strong>Delivery code</strong><div style={{ color: "var(--primary)", fontFamily: "monospace", marginTop: 3 }}>Generated when received</div></div>
        <label>Branch category<select value={category} onChange={e => setCategory(e.target.value)} style={input}>{dbProductCategories.map(c => <option key={c.id}>{c.name}</option>)}{newCategory && <option>{newCategory}</option>}</select></label>
        <label>New private category<input value={newCategory} onChange={e => { setNewCategory(e.target.value); if (e.target.value) setCategory(e.target.value) }} placeholder="Add only for this branch" style={input} /></label>
        <label>Product / variant<select value={variantId} onChange={e => setVariantId(e.target.value)} style={input}>{dbProductVariants.map(v => { const p = dbProducts.find(x => x.id === v.product_id); return <option key={v.id} value={v.id}>{p?.name} {v.dosage} — {v.form}</option> })}</select></label>
        <label>Supplier batch number<input value={batch} onChange={e => setBatch(e.target.value)} placeholder="e.g. PARA-24K" style={input} /></label>
        <label>Expiry date<input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={input} /></label>
        <label>Barcode setup<select value={packaging} onChange={e => setPackaging(e.target.value as Packaging)} style={input}><option value="simple">Simple packs only</option><option value="cartons">Cartons with inner packs</option></select></label>
        <label>Manufacturer<input value={manufacturer} onChange={e => setManufacturer(e.target.value)} placeholder="For batch recalls" style={input} /></label>
        <label>Cost price / piece<input type="number" min="0" value={costPrice} onChange={e => setCostPrice(e.target.value)} style={input} /></label>
        <label>Selling price / piece<input type="number" min="0" value={sellingPrice} onChange={e => setSellingPrice(e.target.value)} style={input} /></label>
      </div>
      <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: "var(--bg)" }}>
        {packaging === "cartons" && <label style={{ display: "inline-block", width: "31%" }}>Cartons<input min="1" type="number" value={cartons} onChange={e => setCartons(+e.target.value)} style={input} /></label>}
        <label style={{ display: "inline-block", width: packaging === "cartons" ? "31%" : "48%", marginLeft: packaging === "cartons" ? "3%" : 0 }}>Packs {packaging === "cartons" ? "per carton" : "received"}<input min="1" type="number" value={packs} onChange={e => setPacks(+e.target.value)} style={input} /></label>
        <label style={{ display: "inline-block", width: packaging === "cartons" ? "31%" : "48%", marginLeft: "3%" }}>Pieces per pack<input min="1" type="number" value={pieces} onChange={e => setPieces(+e.target.value)} style={input} /></label>
      </div>
      <button onClick={() => setSaved(true)} disabled={!batch || !expiry || !costPrice || !sellingPrice} style={{ marginTop: 18, padding: "10px 15px", border: 0, borderRadius: 8, color: "#fff", background: "var(--primary)", fontWeight: 700, cursor: "pointer" }}>Receive delivery & generate barcodes</button>
      {saved && <p style={{ color: "#15803d", fontSize: 12 }}>Ready: {product?.name} will be filed under {category}; the server creates one delivery code for all lines and linked barcode records.</p>}
    </section>
    <aside style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 18 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>Packaging & barcode plan</h2><p style={{ color: "var(--ink-muted)", fontSize: 12 }}>{totalPieces.toLocaleString()} individual pieces received. Pieces do not receive barcodes.</p>
      {preview.map(item => <div key={item.carton || item.packs[0]} style={{ borderLeft: "3px solid var(--primary)", paddingLeft: 10, margin: "12px 0" }}>{item.carton && <div style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700 }}>Carton: {item.carton}</div>}<div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--ink-muted)", marginTop: 4 }}>{item.packs.slice(0, 3).join(" · ")}{item.packs.length > 3 ? ` · +${item.packs.length - 3} packs` : ""}</div></div>)}
      <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--ink-muted)" }}>Parent carton barcode → child pack barcodes → unbarcoded pieces. A simple product skips the parent level.</div>
    </aside>
  </div>
}
