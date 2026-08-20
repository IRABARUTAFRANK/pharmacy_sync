import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import { fmtRWF, alertColors, type AlertSeverity } from './data'

// ─── Card ─────────────────────────────────────────────────────────────────────

export function Card({ children, style = {}, onClick }: { children: ReactNode; style?: CSSProperties; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        borderRadius: 12,
        border: '1px solid var(--border)',
        padding: '18px 20px',
        cursor: onClick ? 'pointer' : undefined,
        transition: 'box-shadow 0.2s',
        ...style,
      }}
      onMouseEnter={onClick ? e => { (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(30,138,74,0.10)' } : undefined}
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
            {typeof p.value === 'number' && p.value > 10000 ? fmtRWF(p.value) : p.value?.toLocaleString?.() ?? p.value}
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
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(13,31,18,0.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div style={{
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
    primary:   { background: 'var(--primary)',       color: '#fff',           border: '1px solid var(--primary)' },
    secondary: { background: 'var(--primary-light)', color: 'var(--primary)', border: '1px solid var(--border-strong)' },
    ghost:     { background: '#fff',                 color: 'var(--ink-mid)', border: '1px solid var(--border)' },
    danger:    { background: '#fef2f2',              color: '#dc2626',        border: '1px solid #fca5a5' },
  }
  return <button onClick={onClick} style={{ ...base, ...variants[variant] }}>{children}</button>
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
