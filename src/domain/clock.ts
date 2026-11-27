/**
 * Clock estimation.
 *
 * Invariants:
 *  - `rawTs` is never rewritten. Every estimate is a derived object with its own
 *    interval and the evidence that produced it.
 *  - A process's log order (`seq`) is authoritative local ordering. Raw clocks
 *    that run backwards do not reorder the log; the model segments there and
 *    keeps the raw value visible.
 *  - Readings bracket an event -> interpolate the offset. If the bracketing
 *    readings disagree beyond the drift bound, a step hides between them and the
 *    interval is widened by the full disagreement (the step could be anywhere).
 *  - Beyond the outermost reading -> extrapolate, widening with drift plus the
 *    process's admitted step size, since raw logs cannot reveal a forward step.
 *  - No reading in the segment -> no numeric estimate at all.
 *
 * Segments start at the first of: a raw backwards step, a declared break marker.
 * A break-only marker (refTs === null) starts a segment and contributes no offset.
 */
import type {
  CalibrationId,
  CalibrationPoint,
  ClockEstimate,
  ClockJump,
  ClockModel,
  EventId,
  LogEvent,
  ProcessId,
  ProcessInfo,
} from './types'

export interface ClockContext {
  eventsByProcess: Map<ProcessId, LogEvent[]>
  calibrations: CalibrationPoint[]
  eventById: Map<EventId, LogEvent>
  /** seq at which each process's raw clock ran backwards; each starts a segment */
  rawBackwardsSeq: Map<ProcessId, number[]>
}

const DRIFT_FLOOR_MS = 1

export function sortBySeq<T extends { seq: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.seq - b.seq)
}

interface Read {
  cal: CalibrationPoint
  anchor: LogEvent
  offset: number
  err: number
}

export function buildClockModel(process: ProcessInfo, ctx: ClockContext): ClockModel {
  const cals = ctx.calibrations.filter((c) => c.processId === process.id)
  const seqOf = (c: CalibrationPoint) => ctx.eventById.get(c.anchorEventId)?.seq ?? 0
  const ordered = [...cals].sort((a, b) => seqOf(a) - seqOf(b))

  const boundaries = Array.from(
    new Set([
      ...(ctx.rawBackwardsSeq.get(process.id) ?? []),
      ...ordered.filter((c) => c.breakBefore).map(seqOf),
    ]),
  ).sort((a, b) => a - b)

  const segmentOf = (seq: number) => boundaries.filter((b) => seq >= b).length

  const reads: Read[] = ordered
    .filter((c) => c.refTs !== null)
    .map((cal) => {
      const anchor = ctx.eventById.get(cal.anchorEventId)
      if (!anchor) return null
      return { cal, anchor, offset: (cal.refTs as number) - anchor.rawTs, err: cal.errorMs }
    })
    .filter((r): r is Read => r !== null)
    .sort((a, b) => a.anchor.seq - b.anchor.seq)

  const readsInSegment = (seg: number) => reads.filter((r) => segmentOf(r.anchor.seq) === seg)
  const driftFor = (rawSpan: number) =>
    (process.driftBoundPpm * Math.abs(rawSpan)) / 1e6 + DRIFT_FLOOR_MS
  const disagree = (a: Read, b: Read) =>
    Math.abs(b.offset - a.offset) > driftFor(b.anchor.rawTs - a.anchor.rawTs) + a.err + b.err

  /* ---------- jumps ---------- */
  const jumps: ClockJump[] = []
  const backwardsSeqs = ctx.rawBackwardsSeq.get(process.id) ?? []
  const breakOnly = ordered.filter((c) => c.breakBefore && c.refTs === null)

  for (let i = 1; i < reads.length; i++) {
    const a = reads[i - 1]
    const b = reads[i]
    if (segmentOf(a.anchor.seq) === segmentOf(b.anchor.seq)) continue
    const delta = b.offset - a.offset
    const fromRaw = backwardsSeqs.some((s) => s > a.anchor.seq && s <= b.anchor.seq)
    jumps.push({
      id: `jump-${a.cal.id}-${b.cal.id}`,
      processId: process.id,
      beforeEventId: a.anchor.id,
      afterEventId: b.anchor.id,
      beforeCalibrationId: a.cal.id,
      afterCalibrationId: b.cal.id,
      deltaMs: delta,
      boundMs: driftFor(b.anchor.rawTs - a.anchor.rawTs),
      fromRawBackwards: fromRaw,
      declared: true,
      message: '',
    })
  }

  // Break-only markers: declared jump with unknown magnitude, located at the marker.
  for (const marker of breakOnly) {
    const anchor = ctx.eventById.get(marker.anchorEventId)
    if (!anchor) continue
    const seg = segmentOf(anchor.seq)
    const priorRead = [...reads].reverse().find((r) => segmentOf(r.anchor.seq) === seg - 1)
    jumps.push({
      id: `jump-marker-${marker.id}`,
      processId: process.id,
      beforeEventId: priorRead?.anchor.id ?? null,
      afterEventId: anchor.id,
      beforeCalibrationId: priorRead?.cal.id ?? null,
      afterCalibrationId: marker.id,
      deltaMs: 0,
      boundMs: 0,
      fromRawBackwards: backwardsSeqs.includes(anchor.seq),
      declared: true,
      message: '',
    })
  }

  // Backwards raw steps that no calibration marker covers.
  for (const seq of backwardsSeqs) {
    const covered = ordered.some(
      (c) => c.breakBefore && Math.abs(seqOf(c) - seq) < 1,
    )
    if (covered) continue
    const anchor = [...reads].find((r) => r.anchor.seq === seq)?.anchor
    const event = ctx.eventById.get(anchor?.id ?? '')
    jumps.push({
      id: `jump-raw-${process.id}-${seq}`,
      processId: process.id,
      beforeEventId: null,
      afterEventId: event?.id ?? '',
      beforeCalibrationId: null,
      afterCalibrationId: null,
      deltaMs: 0,
      boundMs: 0,
      fromRawBackwards: true,
      declared: false,
      message: '',
    })
  }

  // Undeclared jumps: adjacent readings inside one segment disagree.
  for (let i = 1; i < reads.length; i++) {
    const a = reads[i - 1]
    const b = reads[i]
    if (segmentOf(a.anchor.seq) !== segmentOf(b.anchor.seq)) continue
    if (!disagree(a, b)) continue
    jumps.push({
      id: `jump-hidden-${a.cal.id}-${b.cal.id}`,
      processId: process.id,
      beforeEventId: a.anchor.id,
      afterEventId: b.anchor.id,
      beforeCalibrationId: a.cal.id,
      afterCalibrationId: b.cal.id,
      deltaMs: b.offset - a.offset,
      boundMs: driftFor(b.anchor.rawTs - a.anchor.rawTs),
      fromRawBackwards: false,
      declared: false,
      message: '',
    })
  }

  /* ---------- segments ---------- */
  const segments = Array.from({ length: boundaries.length + 1 }, (_, i) => {
    const start = i === 0 ? -Infinity : boundaries[i - 1]
    const end = boundaries[i] ?? Infinity
    const ids = reads
      .filter((r) => r.anchor.seq >= start && r.anchor.seq < end)
      .map((r) => r.cal.id)
    return { index: i, startSeq: start, calibrationIds: ids, hasReading: ids.length > 0 }
  })

  /* ---------- estimate ---------- */
  function estimate(event: LogEvent): ClockEstimate {
    const seg = segmentOf(event.seq)
    const segReads = readsInSegment(seg)
    const unplacedBase = {
      rawTs: event.rawTs,
      est: null,
      lo: null,
      hi: null,
      basis: 'none' as const,
      offsetEst: null,
      bracket: [null, null] as [CalibrationId | null, CalibrationId | null],
      segmentIndex: seg,
      spanUncertain: false,
      unplaced: true,
    }
    if (segReads.length === 0) return unplacedBase

    const before = [...segReads].reverse().find((r) => r.anchor.seq <= event.seq)
    const after = segReads.find((r) => r.anchor.seq >= event.seq)

    if (before && after && before.cal.id === after.cal.id) {
      const r = before
      return {
        rawTs: event.rawTs,
        est: event.rawTs + r.offset,
        lo: event.rawTs + r.offset - r.err,
        hi: event.rawTs + r.offset + r.err,
        basis: 'anchored',
        offsetEst: r.offset,
        bracket: [r.cal.id, null],
        segmentIndex: seg,
        spanUncertain: false,
        unplaced: false,
      }
    }

    if (before && after) {
      const rawSpan = after.anchor.rawTs - before.anchor.rawTs
      const frac = rawSpan === 0 ? 0 : (event.rawTs - before.anchor.rawTs) / rawSpan
      const t = Math.min(1, Math.max(0, frac))
      const offset = before.offset + (after.offset - before.offset) * t
      const uncertain = disagree(before, after)
      const baseErr = Math.max(before.err, after.err) + driftFor(rawSpan)
      if (uncertain) {
        // The readings disagree by more than drift can explain, so a step sits
        // somewhere between them. Publish the full span of offsets as the
        // interval, and withhold the point estimate: a midpoint here would be a
        // number the evidence does not support, and every caller that uses `est`
        // would treat it as a time we believe. Ordering falls back to the
        // interval, or to causal evidence, which is the honest outcome.
        const loOffset = Math.min(before.offset, after.offset) - baseErr
        const hiOffset = Math.max(before.offset, after.offset) + baseErr
        return {
          rawTs: event.rawTs,
          est: null,
          lo: event.rawTs + loOffset,
          hi: event.rawTs + hiOffset,
          basis: 'interpolated',
          offsetEst: null,
          bracket: [before.cal.id, after.cal.id],
          segmentIndex: seg,
          spanUncertain: true,
          unplaced: false,
        }
      }
      const err = baseErr + Math.abs(after.offset - before.offset) * 0.02
      return {
        rawTs: event.rawTs,
        est: event.rawTs + offset,
        lo: event.rawTs + offset - err,
        hi: event.rawTs + offset + err,
        basis: 'interpolated',
        offsetEst: offset,
        bracket: [before.cal.id, after.cal.id],
        segmentIndex: seg,
        spanUncertain: uncertain,
        unplaced: false,
      }
    }

    const r = (before ?? after) as Read
    const rawDist = Math.abs(event.rawTs - r.anchor.rawTs)
    const seqDist = Math.abs(event.seq - r.anchor.seq)
    const err = r.err + driftFor(rawDist) + process.maxStepMs + Math.min(seqDist, 4) * 0.15
    return {
      rawTs: event.rawTs,
      est: event.rawTs + r.offset,
      lo: event.rawTs + r.offset - err,
      hi: event.rawTs + r.offset + err,
      basis: 'extrapolated',
      offsetEst: r.offset,
      bracket: before ? [r.cal.id, null] : [null, r.cal.id],
      segmentIndex: seg,
      spanUncertain: false,
      unplaced: false,
    }
  }

  return {
    processId: process.id,
    calibrated: reads.length > 0,
    anchorCount: reads.length,
    segmentCount: boundaries.length + 1,
    segments,
    jumps,
    estimate,
  }
}

/* ---------- formatting ---------- */

export function fmt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
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
  if (ms === null || ms === undefined) return '—'
  return `${ms >= 0 ? '+' : '−'}${fmt(Math.abs(ms))}`
}

/** UTC clock reading with millisecond precision. */
export function fmtClock(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—'
  const d = new Date(ts)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}
