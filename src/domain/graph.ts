/**
 * Causal graph.
 *
 * Happens-before is the union of:
 *  - explicit edges supplied by the analyst (send → recv, replies, async)
 *  - each process's own log order (consecutive seq steps)
 *
 * The log-order edges are marked `implied` and are never shown as analyst
 * assertions; they exist so that reachability is transitive and correct.
 * Cycles are surfaced, never silently broken, and the edges that sit on a cycle
 * do not contribute to ordering — a happens-before loop proves nothing.
 */
import type { CausalEdge, CausalGraph, EventId, LogEvent, ProcessId } from './types'

export const LOG_EDGE_PREFIX = 'log:'

export function impliedLogEdges(eventsByProcess: Map<ProcessId, LogEvent[]>): CausalEdge[] {
  const out: CausalEdge[] = []
  for (const [pid, list] of eventsByProcess) {
    const sorted = [...list].sort((a, b) => a.seq - b.seq)
    for (let i = 1; i < sorted.length; i++) {
      out.push({
        id: `${LOG_EDGE_PREFIX}${pid}:${sorted[i - 1].seq}->${sorted[i].seq}`,
        from: sorted[i - 1].id,
        to: sorted[i].id,
        kind: 'log',
        label: '日志顺序',
        implied: true,
      })
    }
  }
  return out
}

export function buildGraph(events: LogEvent[], explicit: CausalEdge[], eventsByProcess: Map<ProcessId, LogEvent[]>): CausalGraph {
  const edges = [...explicit, ...impliedLogEdges(eventsByProcess)]
  const outgoing = new Map<EventId, CausalEdge[]>()
  const incoming = new Map<EventId, CausalEdge[]>()
  for (const e of events) {
    outgoing.set(e.id, [])
    incoming.set(e.id, [])
  }
  for (const edge of edges) {
    if (!outgoing.has(edge.from) || !incoming.has(edge.to)) continue
    outgoing.get(edge.from)!.push(edge)
    incoming.get(edge.to)!.push(edge)
  }

  const cyclicEdgeIds = new Set<string>()
  const cycles = findCycles(events, edges, cyclicEdgeIds)
  const usable = edges.filter((e) => !cyclicEdgeIds.has(e.id))

  const adj = new Map<EventId, CausalEdge[]>()
  for (const e of events) adj.set(e.id, [])
  for (const e of usable) adj.get(e.from)!.push(e)

  const descendants = new Map<EventId, Set<EventId>>()
  for (const e of events) {
    const seen = new Set<EventId>()
    const stack = [...adj.get(e.id)!]
    while (stack.length) {
      const edge = stack.pop()!
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      for (const n of adj.get(edge.to) ?? []) stack.push(n)
    }
    seen.delete(e.id)
    descendants.set(e.id, seen)
  }

  const path = (a: EventId, b: EventId): EventId[] | null => {
    if (a === b) return [a]
    const prev = new Map<EventId, EventId>()
    const queue = [a]
    const seen = new Set<EventId>([a])
    while (queue.length) {
      const node = queue.shift()!
      for (const edge of adj.get(node) ?? []) {
        if (seen.has(edge.to)) continue
        seen.add(edge.to)
        prev.set(edge.to, node)
        if (edge.to === b) {
          const chain = [b]
          let cur = b
          while (cur !== a) {
            cur = prev.get(cur)!
            chain.unshift(cur)
          }
          return chain
        }
        queue.push(edge.to)
      }
    }
    return null
  }

  return { outgoing, incoming, descendants, cycles, cyclicEdgeIds, path }
}

/** True when every step of the chain is an implied log-order edge. */
export function chainIsLogOnly(chain: EventId[], outgoing: Map<EventId, CausalEdge[]>): boolean {
  for (let i = 0; i + 1 < chain.length; i++) {
    const step = outgoing.get(chain[i])?.find((e) => e.to === chain[i + 1])
    if (!step || !step.implied) return false
  }
  return true
}

function findCycles(events: LogEvent[], edges: CausalEdge[], cyclicEdgeIds: Set<string>): EventId[][] {
  const adj = new Map<EventId, CausalEdge[]>()
  for (const e of events) adj.set(e.id, [])
  for (const e of edges) adj.get(e.from)?.push(e)

  const index = new Map<EventId, number>()
  const low = new Map<EventId, number>()
  const onStack = new Set<EventId>()
  const stack: EventId[] = []
  const sccs: EventId[][] = []
  let counter = 0

  const strongconnect = (v: EventId) => {
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
    for (const edge of adj.get(v) ?? []) {
      const w = edge.to
      if (!index.has(w)) {
        strongconnect(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: EventId[] = []
      let w: EventId
      do {
        w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      sccs.push(comp)
    }
  }
  for (const e of events) if (!index.has(e.id)) strongconnect(e.id)

  const cyclicComponents: EventId[][] = []
  for (const comp of sccs) {
    const members = new Set(comp)
    const internal = edges.filter((e) => members.has(e.from) && members.has(e.to))
    if (comp.length === 1) {
      const selfLoop = internal.filter((e) => e.from === e.to)
      if (selfLoop.length === 0) continue
      for (const e of selfLoop) cyclicEdgeIds.add(e.id)
      cyclicComponents.push(comp)
      continue
    }
    let touched = false
    for (const e of internal) {
      if (e.implied) continue
      if (reachesWithin(e.to, e.from, adj, members)) {
        cyclicEdgeIds.add(e.id)
        touched = true
      }
    }
    if (touched) cyclicComponents.push(comp)
  }
  return cyclicComponents
}

function reachesWithin(
  from: EventId,
  to: EventId,
  adj: Map<EventId, CausalEdge[]>,
  within: Set<EventId>,
): boolean {
  if (from === to) return true
  const seen = new Set<EventId>()
  const queue = [from]
  while (queue.length) {
    const n = queue.shift()!
    if (n === to) return true
    if (seen.has(n) || !within.has(n)) continue
    seen.add(n)
    for (const e of adj.get(n) ?? []) queue.push(e.to)
  }
  return false
}
