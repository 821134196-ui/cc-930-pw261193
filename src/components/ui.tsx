/** Small shared primitives. */
import type { ReactNode } from 'react'
import type { Verdict } from '../domain/types'

export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent'
  title?: string
}) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {children}
    </span>
  )
}

export const VERDICT_META: Record<Verdict, { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  hold: { label: '成立', tone: 'good' },
  open: { label: '未定', tone: 'warn' },
  conflict: { label: '冲突', tone: 'bad' },
  info: { label: '提示', tone: 'info' },
}

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  const meta = VERDICT_META[verdict]
  return (
    <Chip tone={meta.tone}>
      <VerdictIcon verdict={verdict} />
      {meta.label}
    </Chip>
  )
}

function VerdictIcon({ verdict }: { verdict: Verdict }) {
  if (verdict === 'hold')
    return (
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
        <path d="M2.5 6.4 L4.8 8.7 L9.5 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  if (verdict === 'conflict')
    return (
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
        <path d="M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  if (verdict === 'open')
    return (
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
        <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4.6 4.7 A1.5 1.5 0 1 1 6.5 6.4 L6 6.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
      <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6" cy="6" r="1.4" fill="currentColor" />
    </svg>
  )
}

export function SectionHead({
  title,
  count,
  children,
  hint,
}: {
  title: string
  count?: number
  children?: ReactNode
  hint?: string
}) {
  return (
    <div className="section-head">
      <div className="section-title">
        <h2>{title}</h2>
        {count !== undefined && <span className="count">{count}</span>}
      </div>
      {hint && <p className="section-hint">{hint}</p>}
      {children && <div className="section-actions">{children}</div>}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}
