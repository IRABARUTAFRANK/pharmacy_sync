export default function DatabaseBackedPage({ title, tables }: { title: string; tables: string }) {
  return <div style={{ maxWidth: 720, margin: "48px auto", background: "#fff", border: "1px solid var(--border)", borderRadius: 14, padding: 32, textAlign: "center" }}>
    <div style={{ fontSize: 30, marginBottom: 12 }}>▣</div>
    <h1 style={{ margin: 0, fontSize: 20, color: "var(--ink)" }}>{title} is being connected to live data</h1>
    <p style={{ color: "var(--ink-muted)", lineHeight: 1.6, margin: "12px auto 0", maxWidth: 520 }}>Demo records have been removed from this route. This screen will show only data returned from the pharmacy database after its secured query and workflow are migrated.</p>
    <div style={{ marginTop: 18, background: "var(--bg)", borderRadius: 8, padding: "10px 14px", fontFamily: "monospace", fontSize: 12, color: "var(--primary)" }}>{tables}</div>
  </div>
}
