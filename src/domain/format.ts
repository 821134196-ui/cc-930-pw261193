/** Display formatting. Times are epoch ms; the UI always shows the delta form too. */
import type { EstimateBasis, EventKind } from './types'

export function fmt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—'
  const abs = Math.abs(ms)
  let body: string
  if (abs >= 60000) body = `${(abs / 60000).toFixed(abs >= 600000 ? 0 : 1)}m`
  else if (abs >= 1000) body = `${(abs / 1000).toFixed(abs >= 10000 ? 2 : 3)}s`
  else if (abs >= 100) body = `${abs.toFixed(0)}ms`
  else if (abs >= 10) body = `${abs.toFixed(1)}ms`
  else if (abs >= 1) body = `${abs.toFixed(2)}ms`
  else body = `${abs.toFixed(3)}ms`
  return `${ms < 0 ? '−' : ''}${body}`
}

export function fmtSigned(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—'
  return `${ms >= 0 ? '+' : '−'}${fmt(Math.abs(ms))}`
}

/** UTC clock reading with millisecond precision. */
export function fmtClock(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || Number.isNaN(ts)) return '—'
  const d = new Date(ts)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

/** Relative seconds since the scenario base, e.g. "+4.050s". */
export function fmtRel(ts: number | null | undefined, base: number): string {
  if (ts === null || ts === undefined || Number.isNaN(ts)) return '—'
  return fmtSigned(ts - base)
}

export const BASIS_LABEL: Record<EstimateBasis, string> = {
  none: '无读数',
  anchored: '锚定',
  interpolated: '插值',
  extrapolated: '外推',
}

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  log: '日志',
  send: '发送',
  recv: '接收',
  begin: '开始',
  end: '结束',
  error: '错误',
}
