import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import Barcode from 'react-barcode'
import { fmtRWFExact, alertColors, type AlertSeverity } from './data'
import logoImg from './assets/logo.png'

// ─── Brand mark ───────────────────────────────────────────────────────────────
// One logo for the whole product. The marketing home page and the sign-in
// screens already rendered assets/logo.png with a "Pharm" + accented "Sync"
// wordmark, while the pharmacy dashboard drew its own green "Rx" square and
// the admin portal showed no mark at all -- three different identities across
// one system. Everything renders this now.
//
// `tone="dark"` is for placement on a dark photo panel (AuthShell's left
// column), where --primary is too deep to read and --primary-on-dark is the
// legible end of the same green.

export function Logo({ size = 32, showWordmark = true, tone = 'light' }: {
  size?: number
  showWordmark?: boolean
  tone?: 'light' | 'dark'
}) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <img src={logoImg} alt="PharmSync" width={size} height={size} style={{ objectFit: 'contain', flexShrink: 0 }} />
      {showWordmark && (
        <span style={{
          fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '-0.01em',
          fontSize: Math.round(size * 0.44), color: tone === 'dark' ? '#fff' : 'var(--ink)',
          whiteSpace: 'nowrap',
        }}>
          Pharm<span style={{ color: tone === 'dark' ? 'var(--primary-on-dark)' : 'var(--primary)' }}>Sync</span>
        </span>
      )}
    </span>
  )
}

// ─── Card ─────────────────────────────────────────────────────────────────────

export function Card({ children, style = {}, onClick }: { children: ReactNode; style?: CSSProperties; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={onClick ? 'dashboard-card-clickable' : undefined}
      style={{
        background: '#fff',
        borderRadius: 12,
        border: '1px solid var(--border)',
        padding: '18px 20px',
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
      onMouseEnter={onClick ? e => { (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(30,95,168,0.10)' } : undefined}
      onMouseLeave={onClick ? e => { (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' } : undefined}
    >
      {children}
    </div>
  )
}

// ─── Section Header ───────────────────────────────────────────────────────────

export function SectionHeader({
  title, action, onAction, subtitle,
}: {
  title: string; action?: string; onAction?: () => void; subtitle?: string
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)', letterSpacing: '-0.01em' }}>{title}</h2>
        {subtitle && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--ink-muted)' }}>{subtitle}</p>}
      </div>
      {action && (
        <button
          onClick={onAction}
          style={{
            fontSize: 12, color: 'var(--primary)', background: 'none', border: 'none',
            cursor: 'pointer', fontWeight: 500, padding: '4px 8px', borderRadius: 6,
            fontFamily: 'inherit', transition: 'background 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--primary-light)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
        >
          {action}
        </button>
      )}
    </div>
  )
}

// ─── Custom Recharts Tooltip ──────────────────────────────────────────────────

export function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#fff', border: '1px solid var(--border)', borderRadius: 8,
      padding: '10px 14px', boxShadow: '0 4px 20px rgba(0,0,0,0.08)', fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--ink)', fontSize: 13 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--ink-muted)' }}>{p.name}:</span>
          <span style={{ fontWeight: 600, color: 'var(--ink)' }}>
            {typeof p.value === 'number' && p.value > 10000 ? fmtRWFExact(p.value) : p.value?.toLocaleString?.() ?? p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

export function StatusBadge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, borderRadius: 5, padding: '3px 8px',
      background: bg, color, display: 'inline-block',
    }}>
      {label}
    </span>
  )
}

// ─── Alert Row ────────────────────────────────────────────────────────────────

export function AlertRow({ title, msg, time, type, onDismiss }: {
  title: string; msg: string; time: string; type: AlertSeverity; onDismiss?: () => void
}) {
  const c = alertColors(type)
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8,
      padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start',
    }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: c.dot, marginTop: 4, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: c.text }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-mid)', marginTop: 2, lineHeight: 1.4 }}>{msg}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: 'var(--ink-faint)' }}>{time}</span>
        {onDismiss && (
          <button onClick={onDismiss} style={{
            fontSize: 10, color: c.text, background: 'none', border: `1px solid ${c.border}`,
            borderRadius: 4, padding: '1px 7px', cursor: 'pointer', fontFamily: 'inherit',
          }}>Dismiss</button>
        )}
      </div>
    </div>
  )
}

// ─── Sparkline (inline SVG) ───────────────────────────────────────────────────

export function Sparkline({ data, color, negative }: { data: number[]; color: string; negative?: boolean }) {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const W = 64, H = 28
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - ((v - min) / range) * H}`)
  const polyline = pts.join(' ')
  const fill = `${pts.join(' ')} ${W},${H} 0,${H}`

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <polygon points={fill} fill={color} fillOpacity="0.12" />
      <polyline points={polyline} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// ─── Mini Stat Row ────────────────────────────────────────────────────────────

export function MiniStat({ label, value, color = 'var(--ink)' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--bg-alt)' }}>
      <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color }}>{value}</span>
    </div>
  )
}

// ─── Table ────────────────────────────────────────────────────────────────────

export function Table({
  columns, rows, onRowClick,
}: {
  columns: { key: string; label: string; width?: string | number }[]
  rows: Record<string, ReactNode>[]
  onRowClick?: (row: Record<string, ReactNode>) => void
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {columns.map(c => (
              <th key={c.key} style={{
                textAlign: 'left', padding: '8px 10px',
                color: 'var(--ink-muted)', fontWeight: 500, fontSize: 11,
                letterSpacing: '0.04em', width: c.width,
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              onClick={() => onRowClick?.(row)}
              style={{
                borderBottom: '1px solid var(--bg-alt)', cursor: onRowClick ? 'pointer' : undefined,
                transition: 'background 0.13s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
            >
              {columns.map(c => (
                <td key={c.key} style={{ padding: '9px 10px' }}>{row[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, width = 620 }: {
  title: string; onClose: () => void; children: ReactNode; width?: number
}) {
  return (
    <div className="modal-backdrop" style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(13,31,18,0.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div className="modal-panel" style={{
        background: '#fff', borderRadius: 14, width: '100%', maxWidth: width,
        boxShadow: '0 24px 64px rgba(0,0,0,0.16)', overflow: 'hidden',
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>{title}</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 18,
            color: 'var(--ink-muted)', lineHeight: 1, padding: '2px 6px',
          }}>×</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '20px' }}>{children}</div>
      </div>
    </div>
  )
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

export function ProgressBar({ value, max = 100, color = 'var(--primary)', height = 6 }: {
  value: number; max?: number; color?: string; height?: number
}) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div style={{ height, background: 'var(--border)', borderRadius: height, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: height, transition: 'width 0.4s' }} />
    </div>
  )
}

// ─── Btn ──────────────────────────────────────────────────────────────────────

export function Btn({
  children, variant = 'primary', onClick, small, style = {},
}: {
  children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  onClick?: () => void; small?: boolean; style?: CSSProperties
}) {
  const base: CSSProperties = {
    padding: small ? '5px 12px' : '8px 16px', borderRadius: 8,
    fontSize: small ? 11 : 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', transition: 'all 0.15s', border: '1px solid transparent',
    display: 'inline-flex', alignItems: 'center', gap: 6, ...style,
  }
  const variants: Record<string, CSSProperties> = {
    primary:   { background: 'var(--btn-bg, var(--primary))', color: '#fff',   border: '1px solid var(--primary)' },
    secondary: { background: 'var(--primary-light)', color: 'var(--primary)', border: '1px solid var(--border-strong)' },
    ghost:     { background: '#fff',                 color: 'var(--ink-mid)', border: '1px solid var(--border)' },
    danger:    { background: '#fef2f2',              color: '#dc2626',        border: '1px solid #fca5a5' },
  }
  return <button onClick={onClick} style={{ ...base, ...variants[variant] }}>{children}</button>
}

// ─── Search Select (type-ahead combobox) ──────────────────────────────────────
// A native <select> cannot do substring type-ahead, so every searchable selector
// in the app uses this instead: a text input plus a client-side filtered list.
//
// Two modes:
//  * allowFreeText = false — `value` is an option id. Typing only filters; only a
//    click/Enter on an option commits.
//  * allowFreeText = true  — `value` IS the text. Typing commits as you type, so a
//    name that is not in the list (a brand new supplier or category) is kept.

export interface ComboOption { value: string; label: string; hint?: string }

export function SearchSelect({
  options, value, onSelect, placeholder, allowFreeText = false, disabled = false,
  emptyMessage = 'No matches', createLabel = 'Use new', maxVisible = 60, invalid = false,
}: {
  options: ComboOption[]
  value: string
  onSelect: (value: string) => void
  placeholder?: string
  allowFreeText?: boolean
  disabled?: boolean
  emptyMessage?: string
  createLabel?: string
  maxVisible?: number
  invalid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = options.find(o => o.value === value)
  const display = open ? query : (selected?.label ?? (allowFreeText ? value : ''))
  const needle = query.trim().toLowerCase()
  const matched = needle ? options.filter(o => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(needle)) : options
  const filtered = matched.slice(0, maxVisible)
  const showCreate = allowFreeText && needle.length > 0 && !options.some(o => o.label.trim().toLowerCase() === needle)

  const commit = (next: string) => { onSelect(next); setQuery(''); setOpen(false) }

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={display}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => { if (!disabled) { setQuery(''); setOpen(true) } }}
        onBlur={() => setOpen(false)}
        onChange={e => { setQuery(e.target.value); setOpen(true); if (allowFreeText) onSelect(e.target.value) }}
        onKeyDown={e => {
          if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); return }
          if (e.key === 'Enter' && open) {
            e.preventDefault()
            if (showCreate && filtered.length === 0) commit(query.trim())
            else if (filtered[0]) commit(filtered[0].value)
            else if (showCreate) commit(query.trim())
          }
        }}
        style={{
          width: '100%', padding: '9px 26px 9px 10px', borderRadius: 7, font: 'inherit',
          boxSizing: 'border-box', background: disabled ? 'var(--bg)' : '#fff',
          color: disabled ? 'var(--ink-muted)' : 'var(--ink)',
          border: `1px solid ${invalid ? '#fca5a5' : open ? 'var(--primary)' : 'var(--border)'}`,
          transition: 'border-color 0.15s',
        }}
      />
      {!!value && !disabled && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => commit('')}
          title="Clear"
          style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-faint)',
            fontSize: 15, lineHeight: 1, padding: '0 3px', fontFamily: 'inherit',
          }}
        >×</button>
      )}
      {open && !disabled && (
        <div
          onMouseDown={e => e.preventDefault()}
          style={{
            position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 40,
            background: '#fff', border: '1px solid var(--border)', borderRadius: 9,
            boxShadow: '0 10px 30px rgba(0,0,0,0.10)', maxHeight: 240, overflowY: 'auto', padding: 4,
          }}
        >
          {showCreate && (
            <button
              type="button"
              onClick={() => commit(query.trim())}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 9px', borderRadius: 6, border: 'none',
                background: 'var(--primary-light)', color: 'var(--primary)', fontWeight: 700,
                fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 3,
              }}
            >+ {createLabel}: “{query.trim()}”</button>
          )}
          {filtered.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => commit(o.value)}
              style={{
                width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 6, border: 'none',
                background: o.value === value ? 'var(--bg)' : 'transparent', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 12, color: 'var(--ink)', display: 'block',
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg)' }}
              onMouseLeave={e => { e.currentTarget.style.background = o.value === value ? 'var(--bg)' : 'transparent' }}
            >
              <span style={{ fontWeight: 600 }}>{o.label}</span>
              {o.hint && <span style={{ display: 'block', fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>{o.hint}</span>}
            </button>
          ))}
          {filtered.length === 0 && !showCreate && (
            <div style={{ padding: '10px 9px', fontSize: 11, color: 'var(--ink-muted)' }}>{emptyMessage}</div>
          )}
          {matched.length > filtered.length && (
            <div style={{ padding: '6px 9px', fontSize: 10, color: 'var(--ink-faint)' }}>
              +{matched.length - filtered.length} more — keep typing to narrow the list
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Column Picker ────────────────────────────────────────────────────────────
// Renders a "Columns" toggle button + popover checklist.
// Usage: maintain a Set<string> of visible column keys in the parent.

export function ColumnPicker<T extends string>({
  columns, visible, onToggle,
}: {
  columns: { key: T; label: string }[]
  visible: Set<T>
  onToggle: (key: T) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px',
          borderRadius: 8, border: '1px solid var(--border)', background: open ? 'var(--primary-light)' : '#fff',
          color: open ? 'var(--primary)' : 'var(--ink-mid)', fontSize: 11, fontWeight: 600,
          cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
        }}
      >
        ⊞ Columns <span style={{ background: 'var(--primary)', color: '#fff', borderRadius: 8, padding: '1px 5px', fontSize: 10 }}>{visible.size}</span>
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'absolute', right: 0, top: '110%', zIndex: 50, width: 220,
            background: '#fff', border: '1px solid var(--border)', borderRadius: 10,
            boxShadow: '0 8px 28px rgba(0,0,0,0.10)', padding: '8px 0', overflow: 'hidden',
          }}>
            <div style={{ padding: '6px 12px 8px', fontSize: 10, fontWeight: 700, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--bg-alt)' }}>
              Toggle Columns
            </div>
            {columns.map(col => (
              <label
                key={col.key}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                  cursor: 'pointer', fontSize: 12, color: 'var(--ink)',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLLabelElement).style.background = 'var(--bg)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLLabelElement).style.background = '' }}
              >
                <input
                  type="checkbox"
                  checked={visible.has(col.key)}
                  onChange={() => onToggle(col.key)}
                  style={{ width: 13, height: 13, accentColor: 'var(--primary)', cursor: 'pointer' }}
                />
                {col.label}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Center Alert (auto-dismissing popup) ──────────────────────────────────────
// For things the user must actually notice right away (e.g. a rejected action),
// as opposed to AlertRow's persistent list. Fades in, holds, fades out on its
// own -- render it with `key={message}` so a new message restarts the timer
// instead of the old instance just updating its text mid-animation. Does not
// clear whatever state made it appear; that is the caller's concern, so a
// slower-to-notice reader can still find the message after the popup is gone.
export function CenterAlert({ message, tone = 'error', durationMs = 4000 }: {
  message: string; tone?: 'error' | 'success'; durationMs?: number
}) {
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(true)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    const hideTimer = window.setTimeout(() => setVisible(false), Math.max(durationMs - 250, 250))
    const unmountTimer = window.setTimeout(() => setMounted(false), durationMs)
    return () => { cancelAnimationFrame(raf); window.clearTimeout(hideTimer); window.clearTimeout(unmountTimer) }
  }, [durationMs])

  if (!mounted) return null

  const palette = tone === 'error'
    ? { bg: '#fef2f2', border: '#fca5a5', text: '#b91c1c', icon: '⚠' }
    : { bg: '#f0fdf4', border: '#86efac', text: '#166534', icon: '✓' }

  return (
    <div
      className="no-print"
      onClick={() => setMounted(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, background: visible ? 'rgba(13,31,18,0.28)' : 'rgba(13,31,18,0)',
        transition: 'background 0.25s ease', pointerEvents: visible ? 'auto' : 'none', cursor: 'pointer',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: palette.bg, border: `1.5px solid ${palette.border}`, color: palette.text,
          borderRadius: 14, padding: '20px 26px', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
          display: 'flex', gap: 12, alignItems: 'flex-start', textAlign: 'left', cursor: 'default',
          opacity: visible ? 1 : 0, transform: visible ? 'translateY(0) scale(1)' : 'translateY(-10px) scale(0.96)',
          transition: 'opacity 0.25s ease, transform 0.25s ease',
        }}
      >
        <span style={{ fontSize: 20, flexShrink: 0, lineHeight: 1 }}>{palette.icon}</span>
        <div style={{ fontSize: 13, lineHeight: 1.5, fontWeight: 500 }}>{message}</div>
      </div>
    </div>
  )
}

// ─── Printable barcode labels ──────────────────────────────────────────────────
// Shared between StockReceivingPage (the sheet right after receiving a
// delivery) and BarcodeManagerPage (individual/bulk reprints from history) so
// a printed label looks the same everywhere and only needs to carry price in
// one place. Pharmacy owners print on different hardware -- a laser/inkjet
// printer onto adhesive label sheets, a dedicated thermal barcode printer, or
// sometimes just plain paper as a reference list -- so BarcodeLabelSheet
// offers a layout picker rather than one fixed layout; whichever layout is
// picked is remembered (localStorage) since it matches whatever printer
// someone actually owns, not something that changes print to print.

export interface PrintableBarcode {
  id: string
  code: string
  barcode_type: 'box' | 'pack'
  product_name: string
  variant_label?: string | null
  child_count?: number | null
  pieces_per_pack?: number | null
  price?: number | null
}

export type BarcodeLabelLayout = 'sheet4' | 'sheet2' | 'thermal' | 'list'
export type ThermalLabelSize = '58-continuous' | 'custom'

export interface BarcodePrintDefault {
  layout: BarcodeLabelLayout
  thermalSize: ThermalLabelSize
  customWidthMm?: number
  customHeightMm?: number | null // null = continuous roll (no fixed label height)
}

// 'thermal' isn't listed here -- it gets its own bespoke block in the
// chooser modal below (a size sub-picker, not just a label+hint), so this
// array only needs to cover the options that are one plain clickable card.
const BARCODE_LAYOUT_OPTIONS: { id: Exclude<BarcodeLabelLayout, 'thermal'>; label: string; hint: string }[] = [
  { id: 'sheet4', label: 'Sheet — 4 per row', hint: 'Regular printer + adhesive label sheet (A4/Letter), cut apart' },
  { id: 'sheet2', label: 'Sheet — 2 per row (larger)', hint: 'Regular printer, bigger labels, fewer per sheet' },
  { id: 'list', label: 'Plain list — no stickers', hint: 'Any printer, plain paper -- a reference printout, not adhesive labels' },
]

const THERMAL_SIZE_PRESETS: { id: Exclude<ThermalLabelSize, 'custom'>; label: string; widthMm: number; heightMm: number | null }[] = [
  { id: '58-continuous', label: '58mm continuous roll', widthMm: 58, heightMm: null },
]

const DEFAULT_PRINT_PREF: BarcodePrintDefault = { layout: 'sheet4', thermalSize: '58-continuous' }

// One JSON blob, not several loose keys -- layout and thermal size are
// always chosen together, so they should never end up desynced (e.g. an old
// layout paired with a size picked for a different one) the way independent
// keys could drift after a partial write.
const BARCODE_PRINT_PREF_KEY = 'psync_barcode_print_pref_v2'

function loadStoredPrintPref(): BarcodePrintDefault | null {
  try {
    const raw = localStorage.getItem(BARCODE_PRINT_PREF_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.layout === 'string' && typeof parsed.thermalSize === 'string') {
      return parsed as BarcodePrintDefault
    }
  } catch {
    // corrupt value or storage blocked (private browsing) -- treat as "no default set yet"
  }
  return null
}

function saveStoredPrintPref(pref: BarcodePrintDefault) {
  try {
    localStorage.setItem(BARCODE_PRINT_PREF_KEY, JSON.stringify(pref))
  } catch {
    // per-viewer convenience only; a failed write just means the choice
    // doesn't persist across reloads, not worth surfacing to the user
  }
}

function resolveThermalSize(pref: BarcodePrintDefault): { widthMm: number; heightMm: number | null } {
  if (pref.thermalSize === 'custom') {
    return { widthMm: pref.customWidthMm && pref.customWidthMm > 0 ? pref.customWidthMm : 50, heightMm: pref.customHeightMm ?? null }
  }
  const preset = THERMAL_SIZE_PRESETS.find(p => p.id === pref.thermalSize)
  // Falls back to the one built-in preset for a stale stored value (e.g.
  // from before this only offered one size), not a crash.
  return preset ? { widthMm: preset.widthMm, heightMm: preset.heightMm } : { widthMm: THERMAL_SIZE_PRESETS[0].widthMm, heightMm: THERMAL_SIZE_PRESETS[0].heightMm }
}

// Percentage widths on a flex-wrap container, not CSS Grid's auto-fill: they
// lay out the same way in every browser's print engine, where Grid's
// page-break handling is inconsistent. The horizontal + bottom margin on
// every cell (not a parent `gap`) is what actually keeps adjacent barcodes
// from touching once a row breaks across a printed page boundary -- gap
// alone can collapse right at that boundary in some engines.
const SHEET_MARGIN_PCT = 1

function SheetBarcodeLabel({ label, columns }: { label: PrintableBarcode; columns: 2 | 4 }) {
  const isBox = label.barcode_type === 'box'
  const widthPct = 100 / columns - SHEET_MARGIN_PCT * 2
  const big = columns === 2
  return <div style={{
    width: `${widthPct}%`, margin: `0 ${SHEET_MARGIN_PCT}% 20px ${SHEET_MARGIN_PCT}%`,
    boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
    breakInside: 'avoid', pageBreakInside: 'avoid',
  }}>
    <div style={{ fontSize: big ? 12 : 9, fontWeight: 700, color: 'var(--ink)', textAlign: 'center', lineHeight: 1.25, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label.product_name}</div>
    {label.variant_label && <div style={{ fontSize: big ? 10 : 8, color: 'var(--ink-muted)' }}>{label.variant_label}</div>}
    <Barcode value={label.code} width={big ? 1.8 : 1.2} height={big ? 52 : 36} fontSize={big ? 11 : 9} margin={2} background="transparent" lineColor="#0c1e12" displayValue />
    {label.price != null && <div style={{ fontSize: big ? 13 : 10, fontWeight: 800, color: 'var(--primary, #1e5fa8)' }}>Sell: {fmtRWFExact(label.price)}</div>}
    <div style={{ fontSize: big ? 9 : 7, color: isBox ? 'var(--primary)' : 'var(--ink-muted)', textAlign: 'center', fontWeight: isBox ? 700 : 400 }}>
      {isBox ? `Carton · ${label.child_count ?? 0} packs` : `Pack · ${label.pieces_per_pack ?? 0} pcs`}
    </div>
  </div>
}

// One label per physical thermal label, sized in real mm (from the picked
// preset or a custom size) so it prints close to true size regardless of
// screen DPI. Pure black (no CSS color vars) since thermal print heads are
// monochrome and a themed color can dither into noise that hurts scan
// reliability. break-after: page (+ the vendor-prefixed fallback) advances
// the roll between labels -- but that alone isn't enough: without the
// @page size rule BarcodeLabelSheet injects alongside this, "page" defaults
// to a full A4/Letter sheet, stranding one tiny barcode per giant page
// instead of the roll's own small label size. The two only work together.
function ThermalBarcodeLabel({ label, widthMm, heightMm }: { label: PrintableBarcode; widthMm: number; heightMm: number | null }) {
  const isBox = label.barcode_type === 'box'
  // A fixed heightMm means physically separate die-cut labels -- each one
  // IS its own page, so the printer advances/cuts between them (paired with
  // the @page size rule above). A continuous roll (heightMm null) has no
  // die-cut separation at all: forcing a page break per label there just
  // fragments one strip into many auto-height PDF "pages" with visible gaps
  // between them, instead of flowing as one unbroken roll -- so it gets a
  // plain bottom margin instead, no break.
  const continuous = heightMm == null
  return <div style={{
    width: `${widthMm}mm`, minHeight: heightMm != null ? `${heightMm}mm` : undefined, boxSizing: 'border-box', padding: '2mm',
    marginBottom: continuous ? '2mm' : undefined,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
    ...(continuous ? {} : { breakAfter: 'page', pageBreakAfter: 'always' }),
    breakInside: 'avoid', pageBreakInside: 'avoid',
  }}>
    <div style={{ fontSize: 10, fontWeight: 700, color: '#000', textAlign: 'center', lineHeight: 1.2, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label.product_name}</div>
    {label.variant_label && <div style={{ fontSize: 8, color: '#000' }}>{label.variant_label}</div>}
    <Barcode value={label.code} width={1.6} height={40} fontSize={10} margin={1} background="transparent" lineColor="#000" displayValue />
    <div style={{ fontSize: 9, fontWeight: 700, color: '#000', display: 'flex', gap: 6 }}>
      {label.price != null && <span>Sell: {fmtRWFExact(label.price)}</span>}
      <span>{isBox ? `Carton · ${label.child_count ?? 0}pk` : `${label.pieces_per_pack ?? 0}pcs`}</span>
    </div>
  </div>
}

// Dense table, not stickers -- for someone who just wants a paper reference
// (audit, delivery checklist) rather than adhesive labels, on whatever
// printer/paper they already have.
function BarcodeListRow({ label }: { label: PrintableBarcode }) {
  const isBox = label.barcode_type === 'box'
  return <tr style={{ borderBottom: '1px solid var(--border)' }}>
    <td style={{ padding: '6px 8px' }}>
      <Barcode value={label.code} width={1} height={24} fontSize={8} margin={0} displayValue={false} background="transparent" lineColor="#000" />
    </td>
    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{label.code}</td>
    <td style={{ padding: '6px 8px', fontSize: 11 }}>{label.product_name}{label.variant_label ? ` · ${label.variant_label}` : ''}</td>
    <td style={{ padding: '6px 8px', fontSize: 11 }}>{isBox ? `Carton (${label.child_count ?? 0} packs)` : `Pack (${label.pieces_per_pack ?? 0} pcs)`}</td>
    <td style={{ padding: '6px 8px', fontSize: 11, textAlign: 'right' }}>{label.price != null ? fmtRWFExact(label.price) : '—'}</td>
  </tr>
}

function BarcodeListLayout({ labels }: { labels: PrintableBarcode[] }) {
  return <table style={{ width: '100%', borderCollapse: 'collapse' }}>
    <thead>
      <tr style={{ borderBottom: '2px solid var(--ink)' }}>
        {['Barcode', 'Code', 'Product', 'Type', 'Price'].map((h, i) => (
          <th key={h} style={{ padding: '6px 8px', textAlign: i === 4 ? 'right' : 'left', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ink-muted)' }}>{h}</th>
        ))}
      </tr>
    </thead>
    <tbody>{labels.map(l => <BarcodeListRow key={l.id} label={l} />)}</tbody>
  </table>
}

// One printable sheet: a title (delivery code, carton code, or "Selected
// barcode") and the labels rendered in whichever print preference (layout +
// thermal size, if applicable) is currently the default. Printing always
// opens the layout-choice modal -- the previously-used option is
// pre-highlighted there, so confirming the same one again is still one
// click, but the choice is always visible rather than silently reused.
// `title` is shown both on screen and on the printed page so a cut-apart
// sheet can still be traced back to its source.
//
// `autoTrigger` (set by BarcodeManagerPage, via a fresh `key` per print job
// so this re-opens on every click even back-to-back) opens that same modal
// the instant this mounts, instead of waiting for someone to find and click
// this component's own Print button. BarcodeManagerPage's several
// "Print ___" buttons live scattered through a long list; without this,
// clicking one only rendered this sheet somewhere further down the page,
// and reaching the actual print action meant scrolling down to find it --
// the click and the print action were two separate steps in two different
// places. With it, clicking "Print group" IS the print action: the chooser
// pops up right there (an overlay, not a distant section of the page), and
// in this mode the sheet itself renders print-only (`.print-only` in
// index.css -- screen-hidden, still real content once printing starts) so
// there's no redundant on-page section sitting below the list once the
// modal can do everything the old always-visible toolbar did.
export function BarcodeLabelSheet({ title, labels, loading, error, autoTrigger }: {
  title: string; labels: PrintableBarcode[]; loading?: boolean; error?: string | null; autoTrigger?: boolean
}) {
  const [pref, setPref] = useState<BarcodePrintDefault>(() => loadStoredPrintPref() ?? DEFAULT_PRINT_PREF)
  const [choosingLayout, setChoosingLayout] = useState(() => !!autoTrigger)
  const [showCustomThermal, setShowCustomThermal] = useState(false)
  const [customWidth, setCustomWidth] = useState('50')
  const [customHeight, setCustomHeight] = useState('30')
  const [pendingPrint, setPendingPrint] = useState(false)

  // Printing must wait one render past a preference change -- window.print()
  // called synchronously in the click handler would capture whatever layout
  // was on screen a moment ago, not the one just picked.
  useEffect(() => {
    if (!pendingPrint) return
    const id = requestAnimationFrame(() => { window.print(); setPendingPrint(false) })
    return () => cancelAnimationFrame(id)
  }, [pendingPrint])

  function commitAndPrint(next: BarcodePrintDefault) {
    setPref(next)
    saveStoredPrintPref(next)
    setChoosingLayout(false)
    setShowCustomThermal(false)
    setPendingPrint(true)
  }

  if (loading) return <p style={{ fontSize: 12, color: 'var(--ink-muted)', textAlign: 'center', marginTop: 16 }}>Loading barcode labels…</p>
  if (error) return <p style={{ fontSize: 12, color: '#b91c1c', textAlign: 'center', marginTop: 16 }}>Could not load the barcode labels: {error}</p>
  if (labels.length === 0) return null

  const thermalSize = resolveThermalSize(pref)

  return <div style={autoTrigger ? undefined : { marginTop: 20 }}>
    {pref.layout === 'thermal' && (
      // Without this, "page" defaults to a full A4/Letter sheet and each
      // ThermalBarcodeLabel's own page-break-after strands one barcode per
      // giant page instead of advancing the roll by one small label.
      <style>{`@media print { @page { size: ${thermalSize.widthMm}mm ${thermalSize.heightMm != null ? `${thermalSize.heightMm}mm` : 'auto'}; margin: 0; } }`}</style>
    )}
    {!autoTrigger && (
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <p style={{ fontSize: 11, color: 'var(--ink-muted)', margin: 0 }}>
          {labels.length} barcode{labels.length === 1 ? '' : 's'} ready to print.
        </p>
        <Btn variant="primary" small onClick={() => setChoosingLayout(true)}>🖨 Print / Save as PDF</Btn>
      </div>
    )}
    <div className={autoTrigger ? 'print-only' : undefined} style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: pref.layout === 'list' ? 14 : '14px 14px 0' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)', marginBottom: 14 }}>{title}</div>
      {(pref.layout === 'sheet4' || pref.layout === 'sheet2') && (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-start' }}>
          {labels.map(label => <SheetBarcodeLabel key={label.id} label={label} columns={pref.layout === 'sheet2' ? 2 : 4} />)}
        </div>
      )}
      {pref.layout === 'thermal' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {labels.map(label => <ThermalBarcodeLabel key={label.id} label={label} widthMm={thermalSize.widthMm} heightMm={thermalSize.heightMm} />)}
        </div>
      )}
      {pref.layout === 'list' && <BarcodeListLayout labels={labels} />}
    </div>

    {choosingLayout && (
      <Modal title="Choose a print layout" onClose={() => setChoosingLayout(false)} width={480}>
        <p style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 0, marginBottom: 14 }}>
          Picking one here prints right away, and it's remembered as the highlighted choice next time. Choose "Save as PDF" in your browser's print dialog to download instead of printing.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {BARCODE_LAYOUT_OPTIONS.map(opt => (
            <button
              key={opt.id}
              onClick={() => commitAndPrint({ ...pref, layout: opt.id })}
              style={{
                textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                border: `1.5px solid ${opt.id === pref.layout ? 'var(--primary)' : 'var(--border)'}`,
                background: opt.id === pref.layout ? 'var(--primary-light)' : '#fff',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{opt.label}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 2 }}>{opt.hint}</div>
            </button>
          ))}

          <div style={{
            padding: '12px 14px', borderRadius: 10, border: `1.5px solid ${pref.layout === 'thermal' ? 'var(--primary)' : 'var(--border)'}`,
            background: pref.layout === 'thermal' ? 'var(--primary-light)' : '#fff',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>Thermal roll — one per label</div>
            <div style={{ fontSize: 11, color: 'var(--ink-muted)', margin: '2px 0 8px' }}>Dedicated barcode/thermal label printer — pick your label size:</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {THERMAL_SIZE_PRESETS.map(preset => {
                const active = pref.layout === 'thermal' && pref.thermalSize === preset.id
                return (
                  <button
                    key={preset.id}
                    onClick={() => commitAndPrint({ ...pref, layout: 'thermal', thermalSize: preset.id })}
                    style={{
                      padding: '6px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                      border: `1px solid ${active ? 'var(--primary)' : 'var(--border-strong)'}`,
                      background: active ? '#fff' : 'var(--bg)', color: active ? 'var(--primary)' : 'var(--ink-mid)',
                    }}
                  >
                    {preset.label}
                  </button>
                )
              })}
              <button
                onClick={() => setShowCustomThermal(s => !s)}
                style={{ padding: '6px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', border: '1px dashed var(--border-strong)', background: '#fff', color: 'var(--ink-mid)' }}
              >
                Custom size…
              </button>
            </div>
            {showCustomThermal && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <div>
                  <label style={{ display: 'block', fontSize: 9, color: 'var(--ink-muted)', marginBottom: 2 }}>Width (mm)</label>
                  <input type="number" min={10} max={200} value={customWidth} onChange={e => setCustomWidth(e.target.value)} style={{ width: 60, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 5, fontSize: 11, fontFamily: 'inherit' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 9, color: 'var(--ink-muted)', marginBottom: 2 }}>Height (mm)</label>
                  <input type="number" min={10} max={200} value={customHeight} onChange={e => setCustomHeight(e.target.value)} placeholder="blank = continuous" style={{ width: 100, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 5, fontSize: 11, fontFamily: 'inherit' }} />
                </div>
                <Btn variant="secondary" small onClick={() => {
                  const w = Number(customWidth)
                  if (!w || w <= 0) return
                  const h = customHeight.trim() ? Number(customHeight) : null
                  commitAndPrint({ ...pref, layout: 'thermal', thermalSize: 'custom', customWidthMm: w, customHeightMm: h })
                }}>
                  Use this size
                </Btn>
              </div>
            )}
          </div>
        </div>
      </Modal>
    )}
  </div>
}
