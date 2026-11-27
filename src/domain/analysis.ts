/**
 * Whole-incident analysis.
 *
 * Relation between two events uses the strongest available evidence:
 *   1. causal reachability (explicit edges + each process's log order)
 *   2. calibrated intervals, but only when they are disjoint
 *   3. otherwise: unordered, and the overlap window is reported
 *
 * A disagreement between (1) and (2) is surfaced as a conflict, not resolved
 * silently: if a causal chain proves A before B while the clocks say the
 * opposite, one of the two is wrong and the reader must decide which.
 */
import type {
  Analysis,
  CalibrationPoint,
  CausalEdge,
  CausalGraph,
  ClockEstimate,
  ClockJump,
  ClockModel,
  Conflict,
  EventId,
  LogEvent,
  ProcessId,
  ProcessInfo,
  RawBackwards,
  Relation,
} from './types'
import { buildClockModel } from './clock'
import { buildGraph, chainIsLogOnly } from './graph'
import { fmt } from './format'

export interface AnalyzeInput {
  processes: ProcessInfo[]
  events: LogEvent[]
  edges: CausalEdge[]
  calibrations: CalibrationPoint[]
}

const BACKWARDS_FLOOR_MS = 2

export function analyze(input: AnalyzeInput): Analysis {
  const processRank = new Map(input.processes.map((p, i) => [p.id, i]))
  const events = [...input.events].sort((a, b) => {
    const pa = processRank.get(a.processId) ?? 99
    const pb = processRank.get(b.processId) ?? 99
    return pa !== pb ? pa - pb : a.seq - b.seq
  })
  const eventById = new Map(events.map((e) => [e.id, e]))
  const processById = new Map(input.processes.map((p) => [p.id, p]))
  const eventsByProcess = new Map<ProcessId, LogEvent[]>()
  for (const p of input.processes) eventsByProcess.set(p.id, [])
  for (const e of events) eventsByProcess.get(e.processId)?.push(e)
  for (const [, list] of eventsByProcess) list.sort((a, b) => a.seq - b.seq)

  /* ---------- raw clock going backwards ---------- */
  const rawBackwards: RawBackwards[] = []
  const backwardsSeq = new Map<ProcessId, number[]>()
  for (const [pid, list] of eventsByProcess) {
    const seqs: number[] = []
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1]
      const to = list[i]
      const delta = to.rawTs - from.rawTs
      if (delta < -BACKWARDS_FLOOR_MS) {
        rawBackwards.push({ from, to, delta })
        seqs.push(to.seq)
      }
    }
    if (seqs.length) backwardsSeq.set(pid, seqs)
  }

  /* ---------- clock models ---------- */
  const clocks = new Map<ProcessId, ClockModel>()
  for (const p of input.processes) {
    if (!eventsByProcess.get(p.id)?.length) continue
    clocks.set(p.id, buildClockModel(p, { eventsByProcess, calibrations: input.calibrations, eventById, rawBackwardsSeq: backwardsSeq }))
  }

  const estimates = new Map<EventId, ClockEstimate>()
  for (const e of events) {
    const model = clocks.get(e.processId)
    estimates.set(e.id, model ? model.estimate(e) : emptyEstimate(e.rawTs))
  }

  /* ---------- causal graph ---------- */
  const explicit = input.edges.filter((e) => eventById.has(e.from) && eventById.has(e.to))
  const graph = buildGraph(events, explicit, eventsByProcess)

  /* ---------- conflicts ---------- */
  const conflicts: Conflict[] = []
  const explainedBackwards = new Set<EventId>()
  for (const c of input.calibrations) {
    if (!c.breakBefore) continue
    explainedBackwards.add(c.anchorEventId)
  }
  for (const { from, to, delta } of rawBackwards) {
    if (explainedBackwards.has(to.id)) continue
    conflicts.push({
      id: `raw-${from.id}-${to.id}`,
      kind: 'raw-backwards',
      a: from.id,
      b: to.id,
      processId: from.processId,
      gapMs: -delta,
      message:
        `${processName(processById, from.processId)} 的原始时钟在日志顺序上倒退了 ${fmt(-delta)}：` +
        `${from.id} → ${to.id}。日志顺序仍然权威，但这段的时钟偏移未知。`,
    })
  }

  for (const edge of explicit) {
    const from = eventById.get(edge.from)!
    const to = eventById.get(edge.to)!
    if (graph.cyclicEdgeIds.has(edge.id)) continue
    if (from.processId === to.processId && to.seq < from.seq) {
      conflicts.push({
        id: `edge-log-${edge.id}`,
        kind: 'edge-vs-log',
        a: edge.from,
        b: edge.to,
        edgeId: edge.id,
        processId: from.processId,
        gapMs: 0,
        message: `因果边 ${from.id} → ${to.id} 与同一进程的日志顺序矛盾：日志中 ${to.id} 出现在 ${from.id} 之前。`,
      })
      continue
    }
    const ea = estimates.get(edge.from)!
    const eb = estimates.get(edge.to)!
    if (ea.lo !== null && ea.hi !== null && eb.lo !== null && eb.hi !== null && eb.hi < ea.lo) {
      conflicts.push({
        id: `edge-clock-${edge.id}`,
        kind: 'edge-vs-clock',
        a: edge.from,
        b: edge.to,
        edgeId: edge.id,
        gapMs: ea.lo - eb.hi,
        message:
          `因果边 ${from.id} → ${to.id} 与校准区间矛盾：目标最早的估计时间（${Math.round(eb.lo)}）` +
          `比来源最晚的估计时间（${Math.round(ea.hi)}）还早 ${fmt(ea.lo - eb.hi)}。`,
      })
    }
  }

  for (const cycle of graph.cycles) {
    const edge = explicit.find(
      (e) => graph.cyclicEdgeIds.has(e.id) && cycle.includes(e.from) && cycle.includes(e.to),
    )
    conflicts.push({
      id: `cycle-${cycle.join('|')}`,
      kind: 'cycle',
      a: cycle[0],
      b: cycle[cycle.length - 1],
      edgeId: edge?.id,
      gapMs: 0,
      message:
        `因果边构成环（${cycle.join(' → ')} → …）。环上的边不参与排序，请删除其中一条或补充解释。`,
    })
  }

  /* ---------- jumps ---------- */
  const jumps: ClockJump[] = []
  for (const [, model] of clocks) {
    for (const jump of model.jumps) {
      if (jump.fromRawBackwards && jump.declared && jump.deltaMs !== 0) {
        // The backwards step and the declared break are one event. Report it
        // once, as declared, so the reader is not told about two jumps.
        if (jumps.some((j) => j.processId === jump.processId && j.declared && j.fromRawBackwards)) continue
      }
      jumps.push(withJumpMessage(jump, processById, model, rawBackwards))
    }
  }

  /* ---------- evidence gaps ---------- */
  const sendOut = new Set(explicit.map((e) => e.from))
  const recvIn = new Set(explicit.map((e) => e.to))
  const unpairedSends = events.filter((e) => e.kind === 'send' && !sendOut.has(e.id)).map((e) => e.id)
  const orphanRecvs = events.filter((e) => e.kind === 'recv' && !recvIn.has(e.id)).map((e) => e.id)

  /* ---------- tiers ---------- */
  const { tiers, unplaced } = buildTiers(events, estimates)

  const analysis: Analysis = {
    processes: input.processes,
    events,
    eventsByProcess,
    eventById,
    processById,
    edges: [...explicit, ...graphEdges(graph)],
    explicitEdges: explicit,
    calibrations: input.calibrations,
    clocks,
    estimates,
    graph,
    conflicts,
    jumps,
    rawBackwards,
    unpairedSends,
    orphanRecvs,
    tiers,
    unplaced,
    concurrentWith: () => [],
  }

  analysis.concurrentWith = (id: EventId) => {
    const self = analysis.estimates.get(id)
    if (!self || self.lo === null || self.hi === null) return []
    const selfLo = self.lo
    const selfHi = self.hi
    return analysis.events
      .filter((e) => e.id !== id)
      .filter((e) => {
        const est = analysis.estimates.get(e.id)!
        if (est.lo === null || est.hi === null) return false
        if (Math.max(selfLo, est.lo) > Math.min(selfHi, est.hi)) return false
        return !graph.descendants.get(id)?.has(e.id) && !graph.descendants.get(e.id)?.has(id)
      })
      .map((e) => e.id)
  }

  return analysis
}

function graphEdges(graph: CausalGraph): CausalEdge[] {
  const all: CausalEdge[] = []
  for (const [, list] of graph.outgoing) all.push(...list)
  return all
}

function emptyEstimate(rawTs: number): ClockEstimate {
  return {
    rawTs,
    est: null,
    lo: null,
    hi: null,
    basis: 'none',
    offsetEst: null,
    bracket: [null, null],
    segmentIndex: 0,
    spanUncertain: false,
    unplaced: true,
  }
}

function processName(byId: Map<ProcessId, ProcessInfo>, id: ProcessId): string {
  return byId.get(id)?.name ?? id
}

function withJumpMessage(
  jump: ClockJump,
  processById: Map<ProcessId, ProcessInfo>,
  model: ClockModel,
  rawBackwards: RawBackwards[],
): ClockJump {
  const name = processName(processById, jump.processId)
  const rawHit = rawBackwards.some(
    (r) =>
      r.to.processId === jump.processId &&
      (jump.afterEventId === r.to.id || jump.fromRawBackwards),
  )
  let message: string
  if (jump.deltaMs !== 0 && !jump.declared) {
    message =
      `${name} 在 ${jump.beforeEventId ?? '?'} 与 ${jump.afterEventId} 之间偏移变化 ` +
      `${jump.deltaMs > 0 ? '+' : '−'}${fmt(Math.abs(jump.deltaMs))}，` +
      `超过 ${fmt(jump.boundMs)} 的漂移上限。没有任何日志说明这次跳变，` +
      `因此该区间内的时间只能给出加宽的区间。`
  } else if (jump.deltaMs !== 0) {
    message =
      `${name} 在 ${jump.beforeEventId ?? '?'} 与 ${jump.afterEventId} 之间偏移变化 ` +
      `${jump.deltaMs > 0 ? '+' : '−'}${fmt(Math.abs(jump.deltaMs))}，` +
      `超过 ${fmt(jump.boundMs)} 的漂移上限；已按跳变分段处理。`
  } else if (jump.afterCalibrationId && model.jumps.some((j) => j.id === jump.id && j.beforeCalibrationId === null)) {
    message = `${name} 的抓包证据显示时钟在这里跳变，新段的读数从这里开始生效。`
  } else if (rawHit) {
    message = `${name} 的原始时钟在 ${jump.afterEventId} 处倒退；日志顺序不变，但该点之后的偏移需重新标定。`
  } else {
    message = `${name} 的时钟在 ${jump.afterEventId} 处被声明为跳变点。`
  }
  return { ...jump, message }
}

/* ---------------- tiers of mutually-overlapping intervals ---------------- */

export function buildTiers(
  events: LogEvent[],
  estimates: Map<EventId, ClockEstimate>,
): { tiers: EventId[][]; unplaced: EventId[] } {
  const items: { id: EventId; lo: number; hi: number }[] = []
  const unplaced: EventId[] = []
  for (const e of events) {
    const est = estimates.get(e.id)
    if (!est || est.lo === null || est.hi === null) {
      unplaced.push(e.id)
      continue
    }
    items.push({ id: e.id, lo: est.lo, hi: est.hi })
  }
  items.sort((a, b) => a.lo - b.lo || a.hi - b.hi)

  interface Tier {
    ids: EventId[]
    intersectLo: number
    intersectHi: number
    minLo: number
    maxHi: number
  }
  const tiers: Tier[] = []
  for (const item of items) {
    let placed = false
    for (const tier of tiers) {
      if (Math.max(tier.intersectLo, item.lo) <= Math.min(tier.intersectHi, item.hi)) {
        tier.ids.push(item.id)
        tier.intersectLo = Math.max(tier.intersectLo, item.lo)
        tier.intersectHi = Math.min(tier.intersectHi, item.hi)
        tier.minLo = Math.min(tier.minLo, item.lo)
        tier.maxHi = Math.max(tier.maxHi, item.hi)
        placed = true
        break
      }
    }
    if (!placed) {
      tiers.push({
        ids: [item.id],
        intersectLo: item.lo,
        intersectHi: item.hi,
        minLo: item.lo,
        maxHi: item.hi,
      })
    }
  }

  // A tier may only be ordered before its successor if every member of the
  // earlier tier ends before every member of the later one begins.
  tiers.sort((a, b) => a.minLo - b.minLo)
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i + 1 < tiers.length; i++) {
      if (tiers[i].maxHi >= tiers[i + 1].minLo) {
        const a = tiers[i]
        const b = tiers[i + 1]
        tiers.splice(i, 2, {
          ids: [...a.ids, ...b.ids],
          intersectLo: Math.max(a.intersectLo, b.intersectLo),
          intersectHi: Math.min(a.intersectHi, b.intersectHi),
          minLo: Math.min(a.minLo, b.minLo),
          maxHi: Math.max(a.maxHi, b.maxHi),
        })
        changed = true
        break
      }
    }
  }

  // Tiers are only meaningful if their merged intervals stay disjoint.
  return { tiers: tiers.map((t) => t.ids), unplaced }
}

/* ---------------- pairwise relation ---------------- */

export function relate(aId: EventId, bId: EventId, analysis: Analysis): Relation {
  const base: Relation = {
    kind: 'unknown',
    via: 'none',
    causalKind: null,
    clockKind: null,
    conflict: false,
    overlapLo: null,
    overlapHi: null,
    gapMs: 0,
    missing: false,
  }
  const a = analysis.eventById.get(aId)
  const b = analysis.eventById.get(bId)
  if (!a || !b) return { ...base, missing: true }
  if (aId === bId) return { ...base, kind: 'concurrent' }

  /* causal */
  let causalKind: Relation['causalKind'] = null
  let causalReason: string | undefined
  let chain: EventId[] | undefined
  const aFirst = analysis.graph.descendants.get(aId)?.has(bId) ?? false
  const bFirst = analysis.graph.descendants.get(bId)?.has(aId) ?? false
  if (aFirst || bFirst) {
    causalKind = aFirst ? 'a-before-b' : 'b-before-a'
    chain = analysis.graph.path(aFirst ? aId : bId, aFirst ? bId : aId) ?? undefined
    const logOnly = chain ? chainIsLogOnly(chain, analysis.graph.outgoing) : false
    causalReason = logOnly
      ? `同一进程的日志顺序（${chain?.length ?? 2} 步）`
      : `跨进程因果链（${Math.max(1, (chain?.length ?? 2) - 1)} 条因果边）`
  }

  /* clock */
  const ea = analysis.estimates.get(aId)
  const eb = analysis.estimates.get(bId)
  let clockKind: Relation['clockKind'] = null
  let overlapLo: number | null = null
  let overlapHi: number | null = null
  let gapMs = 0
  let clockReason: string | undefined
  const both = ea && eb && ea.lo !== null && ea.hi !== null && eb.lo !== null && eb.hi !== null
  if (both) {
    const aSpanUncertain = ea!.spanUncertain
    const bSpanUncertain = eb!.spanUncertain
    if (aSpanUncertain || bSpanUncertain) {
      // A hidden step sits inside one of these intervals. Even a disjoint
      // interval cannot license a direction here, because its midpoint does
      // not exist. Say so instead of inventing an order.
      clockKind = 'concurrent'
      overlapLo = Math.max(ea!.lo!, eb!.lo!)
      overlapHi = Math.min(ea!.hi!, eb!.hi!)
      if (overlapHi < overlapLo) {
        overlapLo = null
        overlapHi = null
      }
      clockReason = aSpanUncertain && bSpanUncertain
        ? '两侧区间都可能包含未标注的跳变，无法定向'
        : '其中一侧区间可能包含未标注的跳变，无法定向'
    } else if (ea!.hi! < eb!.lo!) {
      clockKind = 'a-before-b'
      gapMs = eb!.lo! - ea!.hi!
      clockReason = `A 的最晚估计早于 B 的最早估计（间隔 ${fmt(gapMs)}）`
    } else if (eb!.hi! < ea!.lo!) {
      clockKind = 'b-before-a'
      gapMs = ea!.lo! - eb!.hi!
      clockReason = `B 的最晚估计早于 A 的最早估计（间隔 ${fmt(gapMs)}）`
    } else {
      clockKind = 'concurrent'
      overlapLo = Math.max(ea!.lo!, eb!.lo!)
      overlapHi = Math.min(ea!.hi!, eb!.hi!)
      clockReason = `两个区间重叠 ${fmt(overlapHi - overlapLo)}，仅凭时钟无法定序`
    }
  } else {
    const missingSide = ea && ea.lo === null ? 'A' : eb && eb.lo === null ? 'B' : null
    clockReason = missingSide
      ? `${missingSide} 所在时钟区段没有可用读数，无法给出区间`
      : '缺少可用的时钟区间'
  }

  const conflict =
    causalKind !== null && clockKind !== null && clockKind !== 'concurrent' && clockKind !== causalKind

  let kind: Relation['kind'] = 'unknown'
  let via: Relation['via'] = 'none'
  if (causalKind) {
    kind = causalKind
    via = chainIsLogOnly(chain ?? [], analysis.graph.outgoing) ? 'log' : 'causal'
  } else if (clockKind) {
    kind = clockKind
    via = 'clock'
  }

  return {
    kind,
    via,
    causalKind,
    clockKind,
    conflict,
    overlapLo,
    overlapHi,
    gapMs,
    causalReason,
    clockReason,
    chain,
  }
}
