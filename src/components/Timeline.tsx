/**
 * The timeline is the primary view: one swimlane per process.
 *
 * Visual encoding:
 *   x position  = calibrated point estimate (raw clock when the analyst flips
 *                 the toggle — the raw value is never overwritten)
 *   x span      = the published uncertainty interval
 *   row in lane = assigned by interval overlap; overlapping events stack so the
 *                 overlap is visible rather than hidden by a false left-to-right
 *                 order
 *   dashed rule = a *certain cut*: every event left of it ends before every
 *                 event right of it begins. Cuts are the only places the layout
 *                 claims a global order.
 *   hue         = process identity, always paired with the lane name and host
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/store'
import type { ClockEstimate, EventId, LogEvent, ProcessId, ProcessInfo } from '../domain/types'
import { fmt, fmtClock } from '../domain/format'

const RULER_H = 34
const ROW_STEP = 16
const MIN_LANE_H = 46
const LANE_PAD = 9

type Estimates = Map<EventId, ClockEstimate>

interface Layout {
  tMin: number
  tMax: number
  width: number
  x: (ts: number) => number
  ticks: { t: number; label: string }[]
}

interface LaneGeom {
  process: ProcessInfo
  events: LogEvent[]
  rows: Map<EventId, number>
  rowCount: number
  /** y of the lane's top edge, in svg coordinates */
  top: number
  height: number
  /** y of each row's glyph baseline */
  rowY: (row: number) => number
}

export function Timeline() {
  const analysis = useStore((s) => s.analysis)
  const selection = useStore((s) => s.selection)
  const hovered = useStore((s) => s.hovered)
  const focusPair = useStore((s) => s.focusPair)
  const select = useStore((s) => s.select)
  const setHovered = useStore((s) => s.setHovered)
  const baseTs = useStore((s) => s.scenario.baseTs)
  const [zoom, setZoom] = useState(1)
  const [showRaw, setShowRaw] = useState(false)
  const [width, setWidth] = useState(980)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevZoom = useRef(zoom)

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const measure = () => setWidth(Math.max(560, node.clientWidth - 24))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  // Zooming out from a scrolled position would otherwise strand the viewport on
  // empty space: every x scales by the zoom ratio, so keep the time at the
  // centre of the viewport at the centre.
  useLayoutEffect(() => {
    const node = scrollRef.current
    const from = prevZoom.current
    prevZoom.current = zoom
    if (!node || from === zoom) return
    const centre = node.scrollLeft + node.clientWidth / 2
    node.scrollLeft = Math.max(0, centre * (zoom / from) - node.clientWidth / 2)
  }, [zoom])

  const layout = useMemo(
    () => buildLayout(analysis, width, baseTs, zoom, showRaw),
    [analysis, width, baseTs, zoom, showRaw],
  )

  const lanes = useMemo(
    () =>
      analysis.processes.filter((p) => (analysis.eventsByProcess.get(p.id)?.length ?? 0) > 0),
    [analysis],
  )

  const laneGeoms = useMemo<LaneGeom[]>(() => {
    let top = RULER_H
    return lanes.map((process) => {
      const events = analysis.eventsByProcess.get(process.id) ?? []
      const rows = showRaw ? assignRawRows(events) : assignRows(events, analysis.estimates)
      const rowCount = Math.max(1, ...[...rows.values()].map((r) => r + 1))
      const height = Math.max(MIN_LANE_H, rowCount * ROW_STEP + LANE_PAD * 2)
      const origin = top
      top += height
      const innerTop = height - rowCount * ROW_STEP
      return {
        process,
        events,
        rows,
        rowCount,
        top: origin,
        height,
        rowY: (row: number) => origin + innerTop / 2 + row * ROW_STEP + ROW_STEP / 2,
      }
    })
  }, [lanes, analysis, showRaw])

  const cuts = useMemo(() => buildCuts(analysis), [analysis])
  const focusSet = useMemo(() => (focusPair ? new Set(focusPair) : null), [focusPair])

  if (!layout || laneGeoms.length === 0) {
    return (
      <div className="empty-state">
        <p>还没有任何日志。加载一批证据，或手动补一条日志。</p>
      </div>
    )
  }

  const totalH = (laneGeoms[laneGeoms.length - 1]?.top ?? RULER_H) + (laneGeoms[laneGeoms.length - 1]?.height ?? 0) + 10
  const centerById = new Map(laneGeoms.map((l) => [l.process.id, l.top + l.height / 2]))

  return (
    <div className="timeline-wrap" data-testid="timeline">
      <div className="timeline-toolbar">
        <div className="seg" role="group" aria-label="时间基准">
          <button className={!showRaw ? 'on' : ''} onClick={() => setShowRaw(false)} aria-pressed={!showRaw}>
            校准后
          </button>
          <button className={showRaw ? 'on' : ''} onClick={() => setShowRaw(true)} aria-pressed={showRaw}>
            原始时钟
          </button>
        </div>
        <span className="muted small hint">
          {showRaw ? '按各机器自己的时钟绘制，不做任何改写' : '按校准后的估计时间绘制；横条是区间，虚线是确定的先后断点'}
        </span>
        <div className="spacer" />
        <span className="muted small">缩放</span>
        <div className="seg" role="group" aria-label="时间缩放">
          {[1, 2, 4].map((z) => (
            <button key={z} className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)} aria-pressed={zoom === z}>
              {z}×
            </button>
          ))}
        </div>
      </div>

      <div className="timeline-body">
        <div className="lane-labels" style={{ height: totalH }} aria-hidden>
          {laneGeoms.map((lane, i) => (
            <div
              key={lane.process.id}
              className={`lane-label ${i % 2 ? 'alt' : ''}`}
              style={{ top: lane.top, height: lane.height }}
            >
              <span className="lane-label-main">
                <span className="lane-chip" style={{ background: `var(--s${lane.process.colorSlot + 1})` }} />
                <span className="lane-name">{lane.process.name}</span>
              </span>
              <span className="lane-host mono">{lane.process.host}</span>
            </div>
          ))}
        </div>

        <div className={`timeline-scroll ${zoom > 1 ? 'scrolls' : ''}`} ref={scrollRef}>
          <svg
            width={layout.width + 16}
            height={totalH}
            role="img"
            aria-label={`多进程时间线：${analysis.events.length} 个事件，${lanes.length} 个进程`}
          >
            <Ruler layout={layout} />
            {laneGeoms.map((lane, i) => (
              <Lane
                key={lane.process.id}
                lane={lane}
                index={i}
                layout={layout}
                estimates={analysis.estimates}
                selected={selection}
                hovered={hovered}
                focusSet={focusSet}
                showRaw={showRaw}
                onSelect={select}
                onHover={setHovered}
              />
            ))}
            {!showRaw && <Cuts cuts={cuts} layout={layout} totalH={totalH} />}
            <Connections
              layout={layout}
              centerById={centerById}
              selection={selection}
              focusSet={focusSet}
              showRaw={showRaw}
            />
          </svg>
        </div>
      </div>

      <div className="timeline-legend">
        {lanes.map((p) => (
          <span key={p.id} className="legend-item">
            <span className="legend-swatch" style={{ background: `var(--s${p.colorSlot + 1})` }} />
            {p.name}
            <span className="muted tiny mono">{p.host}</span>
          </span>
        ))}
        <span className="legend-item legend-note">
          <span className="legend-span" />
          横条为估计区间，重叠即不可定序
        </span>
        {!showRaw && cuts.length > 0 && (
          <span className="legend-item legend-note">
            <span className="legend-cut" />
            虚线左侧的事件全部早于右侧
          </span>
        )}
      </div>

      <UnplacedStrip />
    </div>
  )
}

/* ---------------- geometry ---------------- */

function buildLayout(
  analysis: ReturnType<typeof useStore.getState>['analysis'],
  width: number,
  baseTs: number,
  zoom: number,
  showRaw: boolean,
): Layout | null {
  if (analysis.events.length === 0) return null
  // The calibrated axis must not be stretched by a machine whose raw clock is
  // 12s off: only events that cannot be placed fall back to their raw stamp.
  const times: number[] = []
  for (const e of analysis.events) {
    const est = analysis.estimates.get(e.id)
    if (showRaw || est?.lo == null || est?.hi == null) {
      times.push(e.rawTs)
      continue
    }
    times.push(est.lo, est.hi)
    if (est.est != null) times.push(est.est)
  }
  let tMin = Math.min(...times)
  let tMax = Math.max(...times)
  const pad = Math.max(15, (tMax - tMin) * 0.02)
  tMin -= pad
  tMax += pad
  const inner = width * zoom
  const x = (ts: number) => ((ts - tMin) / (tMax - tMin)) * inner

  const step = niceStep((tMax - tMin) / Math.max(4, Math.floor(inner / 120)))
  const first = Math.ceil(tMin / step) * step
  const ticks: { t: number; label: string }[] = []
  // One unit for the whole ruler: mixing "+4.0s" and "+4500ms" on the same axis
  // makes neighbouring labels look like different quantities.
  const useSeconds = tMax - tMin >= 1500
  for (let t = first; t <= tMax; t += step) {
    ticks.push({ t, label: fmtTick(t, baseTs, step, useSeconds) })
  }

  return { tMin, tMax, width: inner, x, ticks }
}

/** Ruler labels share one precision, chosen from the tick step itself. */
function fmtTick(ts: number, base: number, step: number, useSeconds: boolean): string {
  const ms = ts - base
  const sign = ms >= 0 ? '+' : '−'
  const abs = Math.abs(ms)
  if (useSeconds) {
    const secs = abs / 1000
    const stepSecs = step / 1000
    let digits = 0
    while (digits < 3 && Math.round(stepSecs * 10 ** digits) !== stepSecs * 10 ** digits) digits++
    return `${sign}${secs.toFixed(digits)}s`
  }
  if (step >= 100) return `${sign}${Math.round(abs)}ms`
  if (step >= 10) return `${sign}${abs.toFixed(1)}ms`
  return `${sign}${abs.toFixed(2)}ms`
}

const STEPS = [
  10, 20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 30_000,
  60_000, 120_000, 300_000, 600_000,
]

function niceStep(raw: number): number {
  for (const c of STEPS) if (c >= raw) return c
  return 600_000
}

/**
 * A *certain cut* is any time no published interval covers. Everything left of
 * it has ended before everything right of it begins — the only global order
 * this evidence licenses. Derived from the union of intervals, not from a
 * chain of pairwise overlaps (A~B and B~C must not erase A < C).
 */
function buildCuts(analysis: ReturnType<typeof useStore.getState>['analysis']): number[] {
  const spans: [number, number][] = []
  for (const e of analysis.events) {
    const est = analysis.estimates.get(e.id)
    if (est?.lo == null || est?.hi == null) continue
    spans.push([est.lo, est.hi])
  }
  spans.sort((a, b) => a[0] - b[0])
  const out: number[] = []
  let hi = -Infinity
  for (const [lo, top] of spans) {
    if (lo > hi && hi !== -Infinity) out.push((hi + lo) / 2)
    if (top > hi) hi = top
  }
  return out
}

function Ruler({ layout }: { layout: Layout }) {
  return (
    <g>
      <line y1={RULER_H - 1} y2={RULER_H - 1} x1={0} x2={layout.width} className="axis-line" />
      {layout.ticks.map((tick) => {
        const x = layout.x(tick.t)
        const anchor = x < 10 ? 'start' : x > layout.width - 10 ? 'end' : 'middle'
        return (
          <g key={tick.t} transform={`translate(${x},0)`}>
            <line y1={RULER_H - 5} y2={RULER_H - 1} className="tick-line" />
            <text y={RULER_H - 10} className="tick-label mono" textAnchor={anchor}>
              {tick.label}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function Cuts({ cuts, layout, totalH }: { cuts: number[]; layout: Layout; totalH: number }) {
  return (
    <g className="cuts" aria-hidden>
      {cuts.map((t) => (
        <g key={t} transform={`translate(${layout.x(t)},0)`}>
          <line y1={RULER_H} y2={totalH - 10} className="cut-line" />
          <path d={`M-3.5,${RULER_H - 8} L0,${RULER_H - 2} L3.5,${RULER_H - 8} Z`} className="cut-mark" />
        </g>
      ))}
    </g>
  )
}

/* ---------------- lane ---------------- */

interface LaneProps {
  lane: LaneGeom
  index: number
  layout: Layout
  estimates: Estimates
  selected: EventId[]
  hovered: EventId | null
  focusSet: Set<EventId> | null
  showRaw: boolean
  onSelect: (id: EventId, additive?: boolean) => void
  onHover: (id: EventId | null) => void
}

function Lane(props: LaneProps) {
  const { lane, index, layout, estimates, selected, hovered, focusSet, showRaw } = props
  const { process, events, rows, height, top } = lane
  const color = `var(--s${process.colorSlot + 1})`
  const colorSoft = `var(--s${process.colorSlot + 1}-soft)`

  return (
    <g transform={`translate(0,${top})`}>
      <rect
        x={0}
        y={2}
        width={layout.width + 12}
        height={height - 4}
        className={index % 2 ? 'lane-band alt' : 'lane-band'}
      />

      {events.map((e) => {
        const est = estimates.get(e.id)!
        const row = rows.get(e.id) ?? 0
        const cy = lane.rowY(row) - top
        const anchorTs = showRaw ? e.rawTs : est.est ?? est.lo ?? e.rawTs
        const cx = layout.x(anchorTs)
        const lo = showRaw ? null : est.lo
        const hi = showRaw ? null : est.hi
        const isSelected = selected.includes(e.id)
        const isHovered = hovered === e.id
        const isFocused = focusSet?.has(e.id) ?? false
        const dim = focusSet !== null && !isFocused
        let intervalStart = 0
        let intervalWidth = 0
        if (lo !== null && hi !== null && hi > lo) {
          intervalStart = layout.x(lo)
          intervalWidth = Math.max(3, layout.x(hi) - intervalStart)
        }
        return (
          <g
            key={e.id}
            className={`ev ${isSelected ? 'sel' : ''} ${dim ? 'dim' : ''}`}
            data-event={e.id}
            transform={`translate(0,${cy})`}
            onClick={(ev) => props.onSelect(e.id, ev.shiftKey || ev.metaKey || ev.ctrlKey)}
            onMouseEnter={() => props.onHover(e.id)}
            onMouseLeave={() => props.onHover(null)}
            onFocus={() => props.onHover(e.id)}
            onBlur={() => props.onHover(null)}
            tabIndex={0}
            role="button"
            aria-pressed={isSelected}
            aria-label={`${process.name} 事件 ${e.seq}：${e.message}，原始时钟 ${fmtClock(e.rawTs)}`}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault()
                props.onSelect(e.id, ev.shiftKey)
              }
            }}
          >
            <title>
              {e.id} · {e.message}
              {'\n'}原始 {fmtClock(e.rawTs)}
              {est.lo !== null && est.hi !== null
                ? `\n区间 ${fmtClock(est.lo)} … ${fmtClock(est.hi)}（宽 ${fmt(est.hi - est.lo)}）`
                : '\n该时钟段无读数'}
            </title>
            {intervalWidth > 0 && (
              <rect
                x={intervalStart}
                y={-5}
                width={intervalWidth}
                height={10}
                rx={2.5}
                className="interval"
                fill={colorSoft}
                stroke={color}
                strokeOpacity={est.spanUncertain ? 0.85 : 0.32}
                strokeDasharray={est.spanUncertain ? '2.5 2' : undefined}
                strokeWidth={1}
              />
            )}
            {(isSelected || isHovered) && (
              <circle cx={cx} cy={0} r={9.5} className="focus-ring" stroke={color} />
            )}
            <EventGlyph kind={e.kind} x={cx} color={color} level={e.level} manual={e.manual} />
          </g>
        )
      })}
    </g>
  )
}

function EventGlyph({
  kind,
  x,
  color,
  level,
  manual,
}: {
  kind: LogEvent['kind']
  x: number
  color: string
  level?: LogEvent['level']
  manual?: boolean
}) {
  const y = 0
  const common = { className: 'glyph', strokeLinejoin: 'round' as const }
  if (kind === 'send')
    return <path d={`M${x - 4.5},${y - 4.6} L${x + 5},${y} L${x - 4.5},${y + 4.6} Z`} fill={color} {...common} />
  if (kind === 'recv')
    return <rect x={x - 3.4} y={y - 3.4} width={6.8} height={6.8} rx={1} fill="none" stroke={color} strokeWidth={2} {...common} />
  if (kind === 'begin')
    return <path d={`M${x},${y - 5} L${x + 5},${y} L${x},${y + 5} L${x - 5},${y} Z`} fill="none" stroke={color} strokeWidth={1.8} {...common} />
  if (kind === 'end')
    return <path d={`M${x},${y - 5} L${x + 5},${y} L${x},${y + 5} L${x - 5},${y} Z`} fill={color} {...common} />
  if (kind === 'error' || level === 'error')
    return (
      <path
        d={`M${x},${y - 5.4} L${x + 5.6},${y + 4.6} L${x - 5.6},${y + 4.6} Z`}
        fill="var(--critical)"
        stroke="var(--surface)"
        strokeWidth={1.2}
        {...common}
      />
    )
  if (manual)
    return <rect x={x - 3.8} y={y - 3.8} width={7.6} height={7.6} rx={2} fill={color} stroke="var(--surface)" strokeWidth={1.2} {...common} />
  return <circle cx={x} cy={y} r={3.4} fill={color} {...common} />
}

/** Raw mode: stack only events whose stamps are within 40ms of each other. */
function assignRawRows(events: LogEvent[]): Map<EventId, number> {
  const rows = new Map<EventId, number>()
  const rowEnds: number[] = []
  for (const e of [...events].sort((a, b) => a.rawTs - b.rawTs)) {
    let row = rowEnds.findIndex((end) => end < e.rawTs - 40)
    if (row === -1) {
      if (rowEnds.length >= 4) row = rowEnds.indexOf(Math.min(...rowEnds))
      else row = rowEnds.length
    }
    rowEnds[row] = e.rawTs
    rows.set(e.id, row)
  }
  return rows
}

/** Greedy interval stacking: events whose intervals overlap cannot sit in the same row. */
function assignRows(events: LogEvent[], estimates: Estimates): Map<EventId, number> {
  const items = events
    .map((e) => {
      const est = estimates.get(e.id)
      const lo = est?.lo ?? est?.est ?? e.rawTs
      const hi = est?.hi ?? est?.est ?? e.rawTs
      return { id: e.id, lo, hi }
    })
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi)
  const rowEnds: number[] = []
  const rows = new Map<EventId, number>()
  for (const item of items) {
    let row = rowEnds.findIndex((end) => end < item.lo)
    if (row === -1) {
      if (rowEnds.length >= 4) row = rowEnds.indexOf(Math.min(...rowEnds))
      else row = rowEnds.length
    }
    rowEnds[row] = item.hi
    rows.set(item.id, row)
  }
  return rows
}

function Connections({
  layout,
  centerById,
  selection,
  focusSet,
  showRaw,
}: {
  layout: Layout
  centerById: Map<ProcessId, number>
  selection: EventId[]
  focusSet: Set<EventId> | null
  showRaw: boolean
}) {
  const analysis = useStore((s) => s.analysis)
  const edges = useMemo(() => analysis.edges.filter((e) => !e.implied), [analysis])

  return (
    <g className="connections">
      {edges.map((edge) => {
        const from = analysis.eventById.get(edge.from)
        const to = analysis.eventById.get(edge.to)
        if (!from || !to) return null
        const isFocus = focusSet ? focusSet.has(edge.from) && focusSet.has(edge.to) : false
        const isSel = selection.includes(edge.from) || selection.includes(edge.to)
        if (!isFocus && !isSel) return null
        const fa = analysis.estimates.get(edge.from)
        const tb = analysis.estimates.get(edge.to)
        const aTs = showRaw ? from.rawTs : fa?.est ?? fa?.lo ?? from.rawTs
        const bTs = showRaw ? to.rawTs : tb?.est ?? tb?.lo ?? to.rawTs
        const y1 = centerById.get(from.processId) ?? 0
        const y2 = centerById.get(to.processId) ?? 0
        const x1 = layout.x(aTs)
        const x2 = layout.x(bTs)
        const sign = y2 >= y1 ? 1 : -1
        return (
          <g key={edge.id} className={`conn-group ${isFocus ? 'focus' : ''}`}>
            <path
              d={`M${x1},${y1 + sign * 6} C${x1 + 20},${y1 + sign * 26} ${x2 - 20},${y2 - sign * 26} ${x2},${y2 - sign * 6}`}
              className="conn"
              fill="none"
            />
            <circle cx={x2} cy={y2 - sign * 6} r={2.2} className="conn-head" />
          </g>
        )
      })}
    </g>
  )
}

function UnplacedStrip() {
  const analysis = useStore((s) => s.analysis)
  const select = useStore((s) => s.select)
  const setHovered = useStore((s) => s.setHovered)
  const [open, setOpen] = useState(true)
  if (analysis.unplaced.length === 0) return null
  return (
    <div className="unplaced-strip">
      <button className="unplaced-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <strong>未定序 · {analysis.unplaced.length}</strong>
        <span className="muted small">这些事件所在时钟段没有读数，不参与任何跨进程排序</span>
        <span className="chevron">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="unplaced-list">
          {analysis.unplaced.map((id) => {
            const e = analysis.eventById.get(id)!
            const p = analysis.processById.get(e.processId)
            return (
              <button
                key={id}
                className="unplaced-chip"
                onClick={() => select(id)}
                onMouseEnter={() => setHovered(id)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="dot" style={{ background: `var(--s${(p?.colorSlot ?? 0) + 1})` }} />
                <span className="mono tiny">{id}</span>
                <span className="muted tiny trunc">{e.message}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
