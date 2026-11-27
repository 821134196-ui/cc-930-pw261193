/** Clock evidence view: per-process offset trend, readings, and jumps. */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/store'
import type { CalibrationPoint, ProcessId, ProcessInfo } from '../domain/types'
import { fmt, fmtRel, fmtSigned } from '../domain/format'
import { SectionHead, Chip, Empty } from './ui'

export function ClockView() {
  const analysis = useStore((s) => s.analysis)
  const baseTs = useStore((s) => s.scenario.baseTs)
  const addBreak = useStore((s) => s.addBreakMarker)

  const processes = analysis.processes.filter((p) => analysis.clocks.has(p.id))
  const [openId, setOpenId] = useState<ProcessId | null>(analysis.jumps.length ? analysis.jumps[0].processId : processes[0]?.id ?? null)

  return (
    <div className="clock-view" data-testid="clock-view">
      <SectionHead
        title="时钟证据"
        hint="每条读数只告诉我们该事件在参考时钟上的时刻。两台机器的偏移被分别估计，读数之间插值，读数之外外推并加宽。"
      />

      <div className="clock-summary">
        {processes.map((p) => {
          const model = analysis.clocks.get(p.id)!
          const jumps = analysis.jumps.filter((j) => j.processId === p.id)
          return (
            <button
              key={p.id}
              className={`proc-card ${openId === p.id ? 'open' : ''}`}
              onClick={() => setOpenId(p.id === openId ? null : p.id)}
              aria-expanded={openId === p.id}
            >
              <div className="proc-card-top">
                <span className="dot" style={{ background: `var(--s${p.colorSlot + 1})` }} />
                <strong>{p.name}</strong>
                <span className="mono tiny muted">{p.host}</span>
              </div>
              <div className="proc-card-stats">
                <Stat label="读数" value={String(model.anchorCount)} />
                <Stat label="时钟段" value={String(model.segmentCount)} />
                <Stat
                  label="跳变"
                  value={jumps.length ? String(jumps.length) : '—'}
                  tone={jumps.length ? 'bad' : undefined}
                />
              </div>
              <div className="muted tiny">
                {model.anchorCount === 0
                  ? '没有读数：该进程不参与时钟比较'
                  : model.anchorCount === 1
                    ? '仅一次读数：远离读数的事件区间会显著变宽'
                    : '多次读数：事件在读数之间插值'}
              </div>
            </button>
          )
        })}
      </div>

      {processes
        .filter((p) => p.id === openId)
        .map((p) => (
          <ProcessClock
            key={p.id}
            process={p}
            onAddBreak={(eventId) => addBreak(p.id, eventId)}
            baseTs={baseTs}
          />
        ))}
      {!openId && <Empty>选择一个进程查看它的偏移变化与读数。</Empty>}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className={`mini-stat ${tone ?? ''}`}>
      <span className="mini-stat-value tnum">{value}</span>
      <span className="mini-stat-label">{label}</span>
    </div>
  )
}

function ProcessClock({
  process,
  onAddBreak,
  baseTs,
}: {
  process: ProcessInfo
  onAddBreak: (eventId: string) => void
  baseTs: number
}) {
  const analysis = useStore((s) => s.analysis)
  const select = useStore((s) => s.select)
  const model = analysis.clocks.get(process.id)!
  const color = `var(--s${process.colorSlot + 1})`
  const jumps = analysis.jumps.filter((j) => j.processId === process.id)
  const readings = analysis.calibrations.filter((c) => c.processId === process.id && c.refTs !== null)
  const events = analysis.eventsByProcess.get(process.id) ?? []

  const chartRef = useRef<HTMLDivElement>(null)
  const [chartW, setChartW] = useState(680)

  useLayoutEffect(() => {
    const node = chartRef.current
    if (!node) return
    const measure = () => setChartW(Math.max(420, node.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const chart = useMemo(
    () => buildOffsetChart(analysis, process, chartW, 208),
    [analysis, process, chartW],
  )

  if (!model) return null

  return (
    <div className="proc-detail">
      <div className="proc-detail-head">
        <h3>
          <span className="dot" style={{ background: color }} /> {process.name} · 偏移 <span className="mono muted">（参考时钟 − 本机时钟）</span>
        </h3>
        <span className="muted tiny">
          假设漂移上限 {process.driftBoundPpm} ppm · 未观测跳变先验 ±{fmt(process.maxStepMs)}
        </span>
      </div>

      <div className="offset-chart-wrap" ref={chartRef}>
        <svg width={chart.width} height={chart.height} role="img" aria-label={`${process.name} 时钟偏移随时间的变化`}>
          <OffsetChart chart={chart} color={color} />
        </svg>
        <div className="chart-legend">
          <span className="legend-item">
            <span className="legend-line" style={{ background: color }} /> 读数之间线性插值
          </span>
          <span className="legend-item">
            <span className="legend-band" style={{ background: color }} /> 读数误差 ±
          </span>
          <span className="legend-item">
            <span className="legend-dash" /> 跳变 / 分段边界
          </span>
          <span className="legend-item legend-note">横轴为参考时钟</span>
        </div>
      </div>

      <div className="columns">
        <div className="col">
          <h4 className="col-title">校准读数</h4>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>锚点事件</th>
                <th className="num">参考时刻</th>
                <th className="num">偏移估计</th>
                <th className="num">±</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {readings.map((c) => {
                const anchor = analysis.eventById.get(c.anchorEventId)
                const off = (c.refTs as number) - (anchor?.rawTs ?? 0)
                return (
                  <tr key={c.id}>
                    <td>
                      <button className="link mono" onClick={() => select(c.anchorEventId)}>
                        {c.anchorEventId}
                      </button>
                      {c.breakBefore && <Chip tone="bad">跳变后</Chip>}
                    </td>
                    <td className="num mono">{fmtRel(c.refTs, baseTs)}</td>
                    <td className="num mono">{fmtSigned(off)}</td>
                    <td className="num mono muted">{fmt(c.errorMs)}</td>
                    <td className="small">{c.source}</td>
                  </tr>
                )
              })}
              {readings.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    没有读数。该进程的时间只有原始值。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="col">
          <h4 className="col-title">跳变与断点</h4>
          {jumps.length === 0 && <p className="muted small">未发现跳变，也未标注断点。</p>}
          <ul className="jump-list">
            {jumps.map((j) => (
              <li key={j.id} className={`jump-item ${j.declared ? 'declared' : 'undeclared'}`}>
                <div className="jump-top">
                  <Chip tone={j.declared ? 'info' : 'bad'}>{j.declared ? '已声明' : '未声明'}</Chip>
                  <span className="mono small">
                    {j.beforeEventId ?? '…'} → {j.afterEventId}
                  </span>
                  <span className="spacer" />
                  {j.deltaMs !== 0 && <span className="mono small">{fmtSigned(j.deltaMs)}</span>}
                </div>
                <p className="small muted">{j.message}</p>
                {!j.declared && j.afterEventId && (
                  <button className="btn tiny" onClick={() => onAddBreak(j.afterEventId)}>
                    在此标注跳变点
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h4 className="col-title">事件时间（原始 vs 校准）</h4>
        <table className="data-table compact">
          <thead>
            <tr>
              <th className="num">seq</th>
              <th>事件</th>
              <th className="num">原始时钟</th>
              <th className="num">校准估计</th>
              <th className="num">区间</th>
              <th>依据</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const est = analysis.estimates.get(e.id)!
              return (
                <tr key={e.id} className={est.unplaced ? 'row-warn' : undefined}>
                  <td className="num mono muted">{e.seq}</td>
                  <td>
                    <button className="link" onClick={() => select(e.id)}>
                      {e.message}
                    </button>
                  </td>
                  <td className="num mono">{fmtRel(e.rawTs, baseTs)}</td>
                  <td className="num mono">{est.est === null ? '—' : fmtRel(est.est, baseTs)}</td>
                  <td className="num mono muted">
                    {est.lo === null ? '无' : `${fmtRel(est.lo, baseTs)} … ${fmtRel(est.hi!, baseTs)}`}
                  </td>
                  <td className="small">
                    {est.spanUncertain ? (
                      <Chip tone="bad">区间含未标注跳变</Chip>
                    ) : est.unplaced ? (
                      <Chip tone="bad">该段无读数</Chip>
                    ) : (
                      est.basis
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface OffsetPoint {
  x: number
  y: number
  cal: CalibrationPoint
  offset: number
  err: number
  segment: number
}

function buildOffsetChart(
  analysis: ReturnType<typeof useStore.getState>['analysis'],
  process: ProcessInfo,
  width: number,
  height: number,
) {
  const padL = 66
  const padR = 18
  const padT = 22
  const padB = 30
  const readings = analysis.calibrations
    .filter((c) => c.processId === process.id && c.refTs !== null)
    .sort((a, b) => (a.refTs as number) - (b.refTs as number))
  const events = analysis.eventsByProcess.get(process.id) ?? []
  const refTimes = readings.map((c) => c.refTs as number)
  const tMin = Math.min(
    ...events.map((e) => analysis.estimates.get(e.id)?.lo ?? e.rawTs),
    ...refTimes,
  )
  const tMax = Math.max(
    ...events.map((e) => analysis.estimates.get(e.id)?.hi ?? e.rawTs),
    ...refTimes,
  )

  const offsets = readings.map((c) => {
    const a = analysis.eventById.get(c.anchorEventId)!
    return { off: (c.refTs as number) - a.rawTs, err: c.errorMs }
  })
  // Tie the vertical domain to the observed offsets. Zero is a useful reference
  // only when it is close to the band; otherwise including it would compress a
  // 2.4s clock step into a flat line at the bottom of a 12s-tall axis.
  let oLo = Math.min(...offsets.map((o) => o.off - o.err), Infinity)
  let oHi = Math.max(...offsets.map((o) => o.off + o.err), -Infinity)
  if (!Number.isFinite(oLo)) { oLo = -50; oHi = 50 }
  const observed = Math.max(20, oHi - oLo)
  if (oLo - observed * 0.25 <= 0 && oHi + observed * 0.25 >= 0) {
    oLo = Math.min(oLo, 0)
    oHi = Math.max(oHi, 0)
  }
  const pad = Math.max(6, (oHi - oLo) * 0.16)
  const oMin = oLo - pad
  const oMax = oHi + pad

  const x = (ts: number) => padL + ((ts - tMin) / Math.max(1, tMax - tMin)) * (width - padL - padR)
  const y = (o: number) => padT + (1 - (o - oMin) / (oMax - oMin)) * (height - padT - padB)

  const points: OffsetPoint[] = readings.map((c) => {
    const a = analysis.eventById.get(c.anchorEventId)!
    const off = (c.refTs as number) - a.rawTs
    const seg = analysis.estimates.get(c.anchorEventId)?.segmentIndex ?? 0
    return { x: x(c.refTs as number), y: y(off), cal: c, offset: off, err: c.errorMs, segment: seg }
  })

  // one run per segment; a segment boundary is never connected by a line
  const segments = new Map<number, OffsetPoint[]>()
  for (const p of points) {
    if (!segments.has(p.segment)) segments.set(p.segment, [])
    segments.get(p.segment)!.push(p)
  }

  const yTicks = niceTicks(oMin, oMax, 4)
  const xTicks = xticks(tMin, tMax, width - padL - padR)
  return { width, height, padL, padR, padT, padB, points, segments, x, y, yTicks, xTicks, tMin, tMax, oMin, oMax }
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step / 2; v += step) out.push(v)
  return out
}

function xticks(tMin: number, tMax: number, spanPx: number): number[] {
  const step = niceStep((tMax - tMin) / Math.max(3, Math.round(spanPx / 110)))
  const out: number[] = []
  for (let t = Math.ceil(tMin / step) * step; t <= tMax + step / 1000; t += step) out.push(t)
  // A tick just past the domain would be drawn past the right edge; drop it.
  return out.filter((t) => t <= tMax + step / 1000)
}

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))))
  const norm = raw / mag
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
}

/**
 * One unit for the whole axis, at the precision the step needs. Per-value units
 * (`fmtSigned`) put "+0.000ms" between "−1.000s" and "+1.000s" on a seconds axis.
 */
function fmtAxis(ms: number, step: number, useSeconds: boolean): string {
  const sign = ms < 0 ? '−' : '+'
  const abs = Math.abs(ms)
  if (!useSeconds) return `${sign}${abs.toFixed(0)}ms`
  const secs = Math.abs(step) / 1000
  let digits = 0
  while (digits < 3 && Math.abs(Math.round(secs * 10 ** digits) - secs * 10 ** digits) > 1e-9) {
    digits++
  }
  return `${sign}${(abs / 1000).toFixed(digits)}s`
}

/** A data label in the axis unit, at full precision (trailing zeros trimmed). */
function fmtValue(ms: number, useSeconds: boolean): string {
  const sign = ms < 0 ? '−' : '+'
  const abs = Math.abs(ms)
  if (!useSeconds) return `${sign}${abs.toFixed(abs >= 100 ? 0 : 1)}ms`
  const secs = abs / 1000
  return `${sign}${secs.toFixed(3).replace(/\.?0+$/, '')}s`
}

/** Width estimate for a chart label in the mono tick face. */
function labelWidth(text: string): number {
  return Math.max(20, text.length * 6.4 + 8)
}

/**
 * Where a reading's label goes. A centred label at the first or last reading
 * would spill over the y axis or the right edge, so it is re-anchored inward,
 * leaving a clear gap from the axis tick labels.
 */
function labelBox(px: number, text: string, padL: number, right: number) {
  const w = labelWidth(text)
  const centred = px - w / 2
  if (centred < padL + 4) {
    const x = px + 8
    return { x, anchor: 'start' as const, from: x, to: x + w }
  }
  if (centred + w > right - 4) {
    const x = px - 8
    return { x, anchor: 'end' as const, from: x - w, to: x }
  }
  return { x: px, anchor: 'middle' as const, from: centred, to: centred + w }
}

/**
 * Reading labels are placed greedily from the right, so the most recent
 * readings keep theirs. A label is dropped only when its box would overlap
 * one already placed *at the same height* — two readings a clock step apart
 * sit at different y and can both be labelled even when vertically aligned.
 */
function placeLabels(
  points: ReturnType<typeof buildOffsetChart>['points'],
  textOf: (p: OffsetPoint) => string,
  yOf: (p: OffsetPoint) => number,
  padL: number,
  right: number,
) {
  const out = new Map<string, { x: number; anchor: 'start' | 'middle' | 'end' }>()
  const placed: { from: number; to: number; y: number }[] = []
  for (const p of [...points].sort((a, b) => b.x - a.x)) {
    const box = labelBox(p.x, textOf(p), padL, right)
    const y = yOf(p)
    const collides = placed.some(
      (b) => Math.abs(b.y - y) < 14 && !(box.to + 12 <= b.from || box.from - 12 >= b.to),
    )
    if (collides) continue
    placed.push({ from: box.from, to: box.to, y })
    out.set(p.cal.id, { x: box.x, anchor: box.anchor })
  }
  return out
}

function OffsetChart({ chart, color }: { chart: ReturnType<typeof buildOffsetChart>; color: string }) {
  const baseTs = useStore((s) => s.scenario.baseTs)
  const { padL, padR, width, height, points, segments, x, y, yTicks, xTicks, padT, padB } = chart
  const right = width - padR
  const bottom = height - padB
  const yStep = yTicks.length > 1 ? Math.abs(yTicks[1] - yTicks[0]) : 1
  const xStep = xTicks.length > 1 ? Math.abs(xTicks[1] - xTicks[0]) : 1
  // Choose the unit from the magnitude of the values, not the tick spacing:
  // a 0.5s step over a 2s band still reads far better as "−3.0s" than "−3000ms",
  // and the point labels must use the same unit as the axis they sit on.
  const ySeconds = Math.max(Math.abs(chart.oMin), Math.abs(chart.oMax)) >= 1500
  const xSeconds = xStep >= 1000
  const labelText = (p: OffsetPoint) => fmtValue(p.offset, ySeconds)
  // Labels ride just above the reading's error bar; use that height so two
  // readings at the same x but different offsets can both keep a label.
  const labelY = (p: OffsetPoint) => y(p.offset + p.err) - 7
  const labels = placeLabels(points, labelText, labelY, padL, right)

  return (
    <g>
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={padL} x2={right} y1={y(t)} y2={y(t)} className="grid-line" />
          <text x={padL - 10} y={y(t)} className="chart-tick mono" textAnchor="end" dominantBaseline="middle">
            {fmtAxis(t, yStep, ySeconds)}
          </text>
        </g>
      ))}
      {chart.oMin < 0 && chart.oMax > 0 && (
        <line x1={padL} x2={right} y1={y(0)} y2={y(0)} className="zero-line" />
      )}

      {xTicks.map((t) => {
        const tx = x(t)
        const anchor = tx < padL + 16 ? 'start' : tx > right - 16 ? 'end' : 'middle'
        return (
          <g key={`x${t}`} transform={`translate(${tx},0)`}>
            <line y1={bottom} y2={bottom + 4} className="tick-line" />
            <text y={bottom + 16} className="chart-tick mono" textAnchor={anchor}>
              {fmtAxis(t - baseTs, xStep, xSeconds)}
            </text>
          </g>
        )
      })}

      {[...segments.entries()].map(([seg, pts]) => {
        if (pts.length === 0) return null
        const first = pts[0]
        const last = pts[pts.length - 1]
        return (
          <g key={seg}>
            <line x1={first.x} x2={last.x} y1={first.y} y2={last.y} stroke={color} strokeWidth={2} strokeLinecap="round" />
            {pts.length === 1 && <circle cx={first.x} cy={first.y} r={2.4} fill={color} />}
          </g>
        )
      })}

      {points.map((p) => (
        <g key={p.cal.id}>
          <line
            x1={p.x} x2={p.x}
            y1={y(p.offset - p.err)} y2={y(p.offset + p.err)}
            stroke={color} strokeWidth={6} strokeOpacity={0.22} strokeLinecap="round"
          />
          <circle cx={p.x} cy={p.y} r={4.2} fill={color} stroke="var(--surface)" strokeWidth={1.8} />
          {labels.has(p.cal.id) && (() => {
            // Keep the label inside the plot; a centred label on the first or
            // last reading would otherwise spill over the axis or the edge.
            const pos = labels.get(p.cal.id)!
            return (
              <text x={pos.x} y={labelY(p)} className="chart-tick mono" textAnchor={pos.anchor}>
                {labelText(p)}
              </text>
            )
          })()}
        </g>
      ))}

      {[...segments.entries()].slice(0, -1).map(([, pts]) => {
        const last = pts[pts.length - 1]
        return (
          <line key={`brk-${last.cal.id}`} x1={last.x + 4} x2={last.x + 4} y1={padT - 6} y2={bottom} className="break-line" />
        )
      })}
      <line x1={padL} x2={padL} y1={padT - 6} y2={bottom} className="zero-line" />
    </g>
  )
}
