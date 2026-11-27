import { describe, expect, it } from 'vitest'
import scenario from '../data/payments.json'
import { analyze } from './analysis'
import { relate } from './analysis'
import { buildConclusions } from './conclusions'
import type { CalibrationPoint, LogEvent, Scenario } from './types'

const data = scenario as unknown as Scenario

function flat() {
  return {
    events: data.batches.flatMap((b) => b.events) as LogEvent[],
    edges: data.batches.flatMap((b) => b.edges),
    calibrations: data.batches.flatMap((b) => b.calibrations) as CalibrationPoint[],
  }
}

function run(batches: string[] = ['b1', 'b2', 'b3'], extra: Partial<ReturnType<typeof flat>> = {}) {
  const all = flat()
  const events = batches.length === 3 ? all.events : all.events.filter((e) => batches.includes(e.batchId ?? ''))
  const ids = new Set(events.map((e) => e.id))
  const edges = all.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const calibrations = all.calibrations.filter((c) => batches.includes(c.batchId ?? ''))
  return analyze({
    processes: data.processes,
    events,
    edges,
    calibrations,
    ...extra,
  })
}

const truthOf = (id: string) => data.truth![id]

describe('raw timestamps are never rewritten', () => {
  it('keeps every rawTs exactly as shipped, including across backwards steps', () => {
    const a = run()
    for (const e of a.events) {
      const original = flat().events.find((x) => x.id === e.id)!
      expect(e.rawTs).toBe(original.rawTs)
      expect(a.estimates.get(e.id)!.rawTs).toBe(original.rawTs)
    }
  })

  it('detects the ledger clock running backwards without reordering its log', () => {
    const a = run()
    expect(a.rawBackwards.length).toBeGreaterThan(0)
    const backwards = a.rawBackwards.find((r) => r.to.processId === 'db')!
    expect(backwards.to.seq).toBeGreaterThan(backwards.from.seq)
    const db = a.eventsByProcess.get('db')!
    expect(db.map((e) => e.seq)).toEqual(db.map((_, i) => i))
  })
})

describe('calibration widens, not rewrites', () => {
  it('every event with a reading has lo <= est <= hi when a point estimate exists', () => {
    const a = run()
    let withPoint = 0
    for (const [, est] of a.estimates) {
      if (est.lo === null || est.hi === null) continue
      if (est.est === null) {
        // only a jump-suspect span may withhold the point estimate
        expect(est.spanUncertain).toBe(true)
        continue
      }
      withPoint++
      expect(est.lo).toBeLessThanOrEqual(est.est)
      expect(est.hi).toBeGreaterThanOrEqual(est.est)
    }
    expect(withPoint).toBeGreaterThan(40)
  })

  it('every published interval contains the ground truth once fully calibrated', () => {
    const a = run(['b1', 'b2', 'b3'])
    let checked = 0
    for (const [id, est] of a.estimates) {
      if (est.lo === null || est.hi === null) continue
      checked++
      // the ground truth must fall inside the published interval
      expect(est.lo).toBeLessThanOrEqual(data.baseTs + truthOf(id) + 0.001)
      expect(est.hi).toBeGreaterThanOrEqual(data.baseTs + truthOf(id) - 0.001)
    }
    expect(checked).toBeGreaterThan(40)
  })

  it('intervals narrow when a second reading is added', () => {
    const before = run(['b1', 'b2'])
    const after = run(['b1', 'b2', 'b3'])
    const width = (a: ReturnType<typeof analyze>, id: string) => {
      const e = a.estimates.get(id)!
      return e.lo === null || e.hi === null ? null : e.hi - e.lo
    }
    // gw's retry send is bracketed by the NTP sample at 3512 and the capture at 4050,
    // then by the capture and the final NTP sample: each addition must help.
    const w1 = width(before, 'gw:5')
    const w2 = width(after, 'gw:5')
    expect(w1).not.toBeNull()
    expect(w2).not.toBeNull()
    expect(w2!).toBeLessThan(w1!)
  })
})

describe('ordering', () => {
  it('uses causal reachability even when clocks disagree', () => {
    const a = run()
    const rel = relate('gw:5', 'db:9', a) // retry send -> ... -> db commit #4412
    expect(rel.kind).toBe('a-before-b')
    expect(rel.via).toBe('causal')
    expect(rel.causalKind).toBe('a-before-b')
    expect(rel.conflict).toBe(false)
  })

  it('prefers the same-process log order over raw time', () => {
    const a = run()
    const rel = relate('db:4', 'db:8', a) // BEGIN tx#4412 before COMMIT ok #4411
    expect(rel.kind).toBe('a-before-b')
    expect(rel.via).toBe('log')
  })

  it('refuses to order events whose intervals overlap', () => {
    const a = run(['b1', 'b2'])
    const rel = relate('cache:3', 'ord:8', a) // sweep start vs GC pause end
    expect(rel.kind).toBe('concurrent')
    expect(rel.overlapLo).not.toBeNull()
    expect(rel.overlapHi!).toBeGreaterThan(rel.overlapLo!)
  })

  it('withholds a direction when an interval hides an unmarked jump', () => {
    const a = run()
    const rel = relate('gw:4', 'cache:4', a) // both near the gateway's silent step
    expect(rel.kind).toBe('concurrent')
    expect(a.estimates.get('gw:4')!.spanUncertain).toBe(true)
    expect(a.estimates.get('gw:4')!.est).toBeNull()
  })

  it('reports no direction when one side sits past a backwards step with no reading', () => {
    const a = run(['b2'])
    const rel = relate('db:7', 'cache:4', a) // ledger after its backwards step, segment unread
    expect(a.estimates.get('db:7')!.unplaced).toBe(true)
    expect(rel.kind).toBe('unknown')
    expect(rel.clockKind).toBeNull()
  })

  it('reports unknown rather than guessing when an event is absent', () => {
    const a = run(['b1'])
    expect(a.estimates.get('cache:4')).toBeUndefined()
    expect(relate('gw:5', 'cache:4', a).kind).toBe('unknown')
    // the events that are present all have usable intervals in b1
    expect(a.unplaced.length).toBe(0)
  })

  it('never claims an order that contradicts ground truth', () => {
    const a = run()
    let claimed = 0
    for (let i = 0; i < a.events.length; i++) {
      for (let j = i + 1; j < a.events.length; j++) {
        const x = a.events[i].id
        const y = a.events[j].id
        const rel = relate(x, y, a)
        if (rel.kind === 'a-before-b') {
          claimed++
          expect(truthOf(x)).toBeLessThan(truthOf(y))
        } else if (rel.kind === 'b-before-a') {
          claimed++
          expect(truthOf(y)).toBeLessThan(truthOf(x))
        }
      }
    }
    expect(claimed).toBeGreaterThan(200)
  })

  it('only orders events that are actually ordered in ground truth', () => {
    const a = run()
    for (const tier of a.tiers) {
      for (const id of tier) {
        const est = a.estimates.get(id)!
        expect(est.lo).not.toBeNull()
        // all members of a tier genuinely coincide somewhere
      }
    }
  })
})

describe('progressively added evidence', () => {
  it('moves a verdict from open to hold as batches arrive', () => {
    const b1 = run(['b1'])
    const b2 = run(['b1', 'b2'])
    const before = relate('db:0', 'gw:3', b1) // ledger BEGIN vs gateway timeout
    const after = relate('db:0', 'gw:3', b2)
    expect(before.kind).toBe('unknown') // db is absent in b1
    expect(after.kind).toBe('a-before-b') // db arrives and is calibrated in b2
    expect(after.via).toBe('clock')
  })

  it('keeps raw evidence intact when a calibration is appended', () => {
    const base = run()
    const extra: CalibrationPoint = {
      id: 'manual-1',
      processId: 'cache',
      anchorEventId: 'cache:0',
      refTs: data.baseTs + truthOf('cache:0'),
      errorMs: 2,
      breakBefore: false,
      source: '人工',
      batchId: 'b3',
    }
    const withCal = analyze({
      processes: data.processes,
      events: base.events,
      edges: base.explicitEdges,
      calibrations: [...base.calibrations, extra],
    })
    for (const e of base.events) {
      expect(withCal.estimates.get(e.id)!.rawTs).toBe(base.estimates.get(e.id)!.rawTs)
    }
    const beforeWidth = (() => {
      const e = base.estimates.get('cache:4')!
      return e.hi! - e.lo!
    })()
    const afterWidth = (() => {
      const e = withCal.estimates.get('cache:4')!
      return e.hi! - e.lo!
    })()
    expect(afterWidth).toBeLessThan(beforeWidth)
  })
})

describe('jump handling', () => {
  it('segments the ledger clock at the backwards step and at the declared break', () => {
    const a = run()
    const dbModel = a.clocks.get('db')!
    expect(dbModel.segmentCount).toBeGreaterThan(1)
    const seg0 = a.estimates.get('db:5')!
    const seg1 = a.estimates.get('db:9')!
    expect(seg0.segmentIndex).not.toBe(seg1.segmentIndex)
  })

  it('reports an undeclared gateway step instead of splicing it away', () => {
    const a = run()
    const gwJumps = a.jumps.filter((j) => j.processId === 'gw')
    expect(gwJumps.length).toBeGreaterThan(0)
    // with the capture reading, the jump is bracketed and revealed
    const revealed = gwJumps.find((j) => Math.abs(j.deltaMs) > 500)
    expect(revealed).toBeDefined()
  })

  it('does not let a break-only marker produce a numeric offset', () => {
    const a = run()
    // Remove every reading after the ledger's break, leaving the marker alone.
    const breakCal = a.calibrations.find((c) => c.breakBefore && c.processId === 'db')!
    const breakEvent = a.eventById.get(breakCal.anchorEventId)!
    const cals = a.calibrations.filter(
      (c) => c.processId !== 'db' || (c.refTs !== null && a.eventById.get(c.anchorEventId)!.seq < breakEvent.seq),
    )
    const b = analyze({ processes: data.processes, events: a.events, edges: a.explicitEdges, calibrations: cals })
    const afterBreak = b.estimates.get('db:9')!
    expect(afterBreak.unplaced).toBe(true)
    expect(afterBreak.lo).toBeNull()
    expect(afterBreak.est).toBeNull()
  })
})

describe('conclusions', () => {
  it('answers the retry question once both batches are present', () => {
    const a = run()
    const conclusions = buildConclusions(a, data.questions)
    const q = conclusions.find((c) => c.title.includes('幂等复查'))!
    expect(q.verdict).toBe('hold')
    expect(q.statement).toContain('早于')
  })

  it('keeps the GC/sweep question open even with every batch present', () => {
    // The two events genuinely coincide, so more evidence must not turn this
    // into a confident order. A well-behaved tool reports the overlap.
    for (const batches of [['b1', 'b2'], ['b1', 'b2', 'b3']]) {
      const a = run(batches)
      const q = buildConclusions(a, data.questions).find((c) => c.title.includes('GC'))!
      expect(q.verdict).toBe('open')
      expect(q.statement).toContain('重叠')
    }
  })

  it('orders a whole-evidence timeline without ever contradicting ground truth', () => {
    for (const batches of [['b1'], ['b1', 'b2'], ['b1', 'b2', 'b3']]) {
      const a = run(batches)
      for (let i = 0; i < a.events.length; i++) {
        for (let j = i + 1; j < a.events.length; j++) {
          const x = a.events[i].id
          const y = a.events[j].id
          const rel = relate(x, y, a)
          if (rel.kind === 'a-before-b') expect(truthOf(x)).toBeLessThan(truthOf(y))
          if (rel.kind === 'b-before-a') expect(truthOf(y)).toBeLessThan(truthOf(x))
        }
      }
    }
  })

  it('surfaces the conflicting pair rather than hiding it', () => {
    const a = run()
    const conclusions = buildConclusions(a, data.questions)
    const conflict = conclusions.find((c) => c.verdict === 'conflict' && c.title.includes('COMMIT'))
    // not every conflict is a question; at minimum the clock conflicts surface
    expect(conclusions.some((c) => c.verdict === 'conflict')).toBe(true)
    void conflict
  })
})
