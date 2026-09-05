import { useState, type ReactNode } from "react"

// Hover-to-expand ("mini") sidebar: collapsed to icon-only width by default,
// expands to full width with labels on hover, and collapses again on
// mouse-out -- the pattern used across most POS/admin dashboards. `pinned`
// lets a caller lock it open (e.g. a manual toggle button elsewhere in the
// shell) without touching the hover mechanics here; hovering a pinned
// sidebar is a no-op since it's already expanded. Keyboard users get the
// same expansion on focus (via Tab into a nav item), not just mouse hover,
// so labels aren't mouse-only.
//
// `header`, `topContent`, and `footer` are render-prop slots (not plain
// nodes) because almost everything a caller puts there -- a wordmark next to
// a logo mark, a role badge, a username -- needs to hide when collapsed and
// only that caller knows how; this component only knows whether it's
// currently expanded, not what any of that content looks like.

export interface SidebarNavItem {
  id: string
  icon: ReactNode
  badge?: number
}

export interface SidebarProps {
  items: SidebarNavItem[]
  activeId: string
  onSelect: (id: string) => void
  getLabel: (id: string) => string
  onItemHover?: (id: string) => void
  pinned?: boolean
  collapsedWidth?: number
  expandedWidth?: number
  header?: (expanded: boolean) => ReactNode
  topContent?: (expanded: boolean) => ReactNode
  footer?: (expanded: boolean) => ReactNode
  className?: string
}

export function Sidebar({
  items, activeId, onSelect, getLabel, onItemHover, pinned = false,
  collapsedWidth = 60, expandedWidth = 240, header, topContent, footer, className,
}: SidebarProps) {
  const [hovering, setHovering] = useState(false)
  const [focused, setFocused] = useState(false)
  const expanded = pinned || hovering || focused
  const width = expanded ? expandedWidth : collapsedWidth

  return (
    <aside
      className={className}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setFocused(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false) }}
      style={{
        width, minWidth: width, background: "#fff", borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", transition: "width 0.22s, min-width 0.22s",
        overflow: "hidden", flexShrink: 0, zIndex: 10,
      }}
    >
      {header?.(expanded)}
      {topContent?.(expanded)}

      <nav style={{ flex: 1, padding: "10px 8px", overflowY: "auto", overflowX: "hidden" }}>
        {items.map(item => {
          const active = item.id === activeId
          const label = getLabel(item.id)
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "var(--bg)"; onItemHover?.(item.id) }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent" }}
              title={!expanded ? label : undefined}
              style={{
                width: "100%", display: "flex", alignItems: "center",
                gap: expanded ? 10 : 0, justifyContent: expanded ? "flex-start" : "center",
                padding: expanded ? "9px 10px" : "9px 12px", borderRadius: 8,
                border: "none", background: active ? "var(--primary-light)" : "transparent",
                color: active ? "var(--primary)" : "var(--ink-mid)",
                fontWeight: active ? 600 : 400, fontSize: 13, cursor: "pointer",
                marginBottom: 2, fontFamily: "inherit", transition: "all 0.14s",
                position: "relative",
              }}
            >
              <span style={{ fontSize: 16, flexShrink: 0, display: "flex", alignItems: "center" }}>{item.icon}</span>
              {expanded && (
                <>
                  <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                  {!!item.badge && (
                    <span style={{
                      background: "#dc2626", color: "#fff", fontSize: 10, fontWeight: 700,
                      borderRadius: 10, padding: "1px 6px", flexShrink: 0,
                    }}>{item.badge}</span>
                  )}
                </>
              )}
              {!expanded && !!item.badge && (
                <span style={{ position: "absolute", top: 6, right: 6, width: 8, height: 8, borderRadius: "50%", background: "#dc2626" }} />
              )}
            </button>
          )
        })}
      </nav>

      {footer?.(expanded)}
    </aside>
  )
}
