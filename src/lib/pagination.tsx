import { useEffect, useState, type DependencyList } from "react"
import { useTranslation } from "./i18n"

const DEFAULT_PAGE_SIZE = 25

// Client-side "show more" pagination. Every list in this app already arrives
// as one in-memory array -- an RPC's own result, or a query capped with
// .limit() -- there is no true offset-paginated endpoint to page against. This
// slices that array for rendering, so a branch/product/history list that has
// grown to hundreds of rows still opens as one short page instead of dumping
// everything on screen at once.
//
// `resetDeps` works like useEffect's own dependency list: pass the PRIMITIVE
// values that should snap the view back to the first page when they change
// (a search term, an active filter). Pass `[]` for a list with no filter of
// its own, so a background refresh doesn't reset someone's scroll position
// back to the top. Deliberately does NOT key off `items` itself -- that
// array is a fresh reference on almost every render (most callers derive it
// with .filter()/.map()), which would reset the page on every render and
// make "show more" never advance.
export function usePagedList<T>(items: T[], resetDeps: DependencyList, pageSize = DEFAULT_PAGE_SIZE) {
  const [visibleCount, setVisibleCount] = useState(pageSize)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setVisibleCount(pageSize) }, resetDeps)

  const shown = Math.min(visibleCount, items.length)
  return {
    visible: items.slice(0, shown),
    hasMore: shown < items.length,
    showMore: () => setVisibleCount(c => Math.min(c + pageSize, items.length)),
    shown,
    total: items.length,
  }
}

export function LoadMoreButton({ hasMore, shown, total, onClick }: {
  hasMore: boolean; shown: number; total: number; onClick: () => void
}) {
  const { t } = useTranslation()
  if (!hasMore) return null
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "16px 0 4px" }}>
      <button
        onClick={onClick}
        style={{
          padding: "8px 22px", borderRadius: 8, border: "1px solid var(--border)", background: "#fff",
          color: "var(--primary)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--bg)" }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "#fff" }}
      >
        {t("common.loadMore")}
      </button>
      <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{t("common.shownOfTotal", { shown, total })}</span>
    </div>
  )
}
