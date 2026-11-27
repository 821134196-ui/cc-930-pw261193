import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import scenarioJson from '../data/payments.json'
import { analyze } from '../domain/analysis'
import { buildConclusions } from '../domain/conclusions'
import type {
  Analysis,
  CalibrationPoint,
  CausalEdge,
  Conclusion,
  EventId,
  LogEvent,
  ProcessId,
  ReviewChange,
  ReviewSnapshot,
  Scenario,
  ScenarioQuestion,
} from '../domain/types'

const scenario = scenarioJson as unknown as Scenario

export type View = 'timeline' | 'clock' | 'review' | 'data'

export interface Toast {
  id: number
  kind: 'ok' | 'warn' | 'err'
  title: string
  body?: string
}

/** The evidence subset the analysis is computed from. */
export interface EvidenceState {
  scenario: Scenario
  loadedBatchIds: string[]
  manualEvents: LogEvent[]
  manualEdges: CausalEdge[]
  manualCalibrations: CalibrationPoint[]
  hiddenEdgeIds: string[]
}

interface State extends EvidenceState {
  selection: EventId[]
  hovered: EventId | null
  focusPair: [EventId, EventId] | null
  focusConclusion: string | null
  view: View
  theme: 'dark' | 'light'
  leftOpen: boolean
  inspectorOpen: boolean
  manualQuestions: ScenarioQuestion[]
  snapshots: ReviewSnapshot[]
  reviewedAt: Record<string, string>
  toasts: Toast[]

  analysis: Analysis
  conclusions: Conclusion[]

  loadBatch: (id: string) => void
  loadAll: () => void
  reset: () => void

  addCalibration: (point: Omit<CalibrationPoint, 'id' | 'batchId' | 'manual' | 'createdAt'>) => void
  addBreakMarker: (processId: ProcessId, eventId: EventId, note?: string) => void
  removeCalibration: (id: string) => void
  addEdge: (from: EventId, to: EventId, label?: string) => void
  removeEdge: (id: string) => void
  addEvent: (event: Pick<LogEvent, 'processId' | 'rawTs' | 'kind' | 'message' | 'level'>) => void
  addQuestion: (a: EventId, b: EventId, title: string) => void
  removeQuestion: (id: string) => void

  select: (id: EventId, additive?: boolean) => void
  clearSelection: () => void
  setHovered: (id: EventId | null) => void
  focusPairIn: (a: EventId, b: EventId, conclusionId?: string) => void
  setView: (view: View) => void
  toggleTheme: () => void
  setLeftOpen: (open: boolean) => void
  setInspectorOpen: (open: boolean) => void
  snapshotReview: () => void
  markReviewed: (id: string) => void
  toast: (kind: Toast['kind'], title: string, body?: string) => void
  dismissToast: (id: number) => void
}

let counter = 0
const nextId = (prefix: string) => `${prefix}-${++counter}`

export function collectEvidence(state: EvidenceState) {
  const batches = state.scenario.batches.filter((b) => state.loadedBatchIds.includes(b.id))
  const events = [...batches.flatMap((b) => b.events), ...state.manualEvents]
  const edgeMap = new Map<string, CausalEdge>()
  for (const b of batches) for (const e of b.edges) edgeMap.set(e.id, e)
  for (const e of state.manualEdges) edgeMap.set(e.id, e)
  for (const id of state.hiddenEdgeIds) edgeMap.delete(id)
  const calMap = new Map<string, CalibrationPoint>()
  for (const b of batches) for (const c of b.calibrations) calMap.set(c.id, c)
  for (const c of state.manualCalibrations) calMap.set(c.id, c)
  return { events, edges: [...edgeMap.values()], calibrations: [...calMap.values()] }
}

export function computeAnalysis(state: EvidenceState, questions: ScenarioQuestion[]) {
  const { events, edges, calibrations } = collectEvidence(state)
  const analysis = analyze({ processes: state.scenario.processes, events, edges, calibrations })
  const conclusions = buildConclusions(analysis, [...state.scenario.questions, ...questions])
  return { analysis, conclusions }
}

function snapshotOf(conclusions: Conclusion[], version: number): ReviewSnapshot {
  return {
    version,
    at: Date.now(),
    conclusions: conclusions.map((c) => ({
      id: c.id,
      title: c.title,
      statement: c.statement,
      verdict: c.verdict,
      events: c.events,
    })),
  }
}

const initialState: EvidenceState & { manualQuestions: ScenarioQuestion[] } = {
  scenario,
  loadedBatchIds: [scenario.batches[0].id],
  manualEvents: [],
  manualEdges: [],
  manualCalibrations: [],
  hiddenEdgeIds: [],
  manualQuestions: [],
}

const first = computeAnalysis(initialState, initialState.manualQuestions)

export type PersistedState = Pick<
  State,
  | 'loadedBatchIds'
  | 'manualEvents'
  | 'manualEdges'
  | 'manualCalibrations'
  | 'manualQuestions'
  | 'hiddenEdgeIds'
  | 'theme'
  | 'leftOpen'
  | 'inspectorOpen'
  | 'snapshots'
  | 'reviewedAt'
>

export const useStore = create<State>()(
  persist(
    (set, get) => {
      /** Apply an evidence edit, recompute, and record a review snapshot. */
      const edit = (
        patch: Partial<Pick<EvidenceState, 'manualEvents' | 'manualEdges' | 'manualCalibrations' | 'hiddenEdgeIds'>>,
        questions: ScenarioQuestion[] = get().manualQuestions,
      ) => {
        const s = get()
        const evidence: EvidenceState = {
          scenario: s.scenario,
          loadedBatchIds: s.loadedBatchIds,
          manualEvents: s.manualEvents,
          manualEdges: s.manualEdges,
          manualCalibrations: s.manualCalibrations,
          hiddenEdgeIds: s.hiddenEdgeIds,
          ...patch,
        }
        const { analysis, conclusions } = computeAnalysis(evidence, questions)
        set({
          ...evidence,
          manualQuestions: questions,
          analysis,
          conclusions,
          selection: s.selection.filter((id) => analysis.eventById.has(id)),
          snapshots: [...s.snapshots, snapshotOf(conclusions, s.snapshots.length + 1)],
        })
        return analysis
      }

      return {
        ...initialState,
        selection: [],
        hovered: null,
        focusPair: null,
        focusConclusion: null,
        view: 'timeline',
        theme: 'dark',
        leftOpen: true,
        inspectorOpen: true,
        snapshots: [snapshotOf(first.conclusions, 1)],
        reviewedAt: {},
        toasts: [],
        analysis: first.analysis,
        conclusions: first.conclusions,

        loadBatch: (id) => {
          const s = get()
          if (s.loadedBatchIds.includes(id)) return
          const next = [...s.loadedBatchIds, id]
          const evidence: EvidenceState = { ...s, loadedBatchIds: next }
          const { analysis, conclusions } = computeAnalysis(evidence, s.manualQuestions)
          set({
            loadedBatchIds: next,
            analysis,
            conclusions,
            snapshots: [...s.snapshots, snapshotOf(conclusions, s.snapshots.length + 1)],
          })
          const batch = s.scenario.batches.find((b) => b.id === id)
          get().toast('ok', `已加载「${batch?.title ?? id}」`, '结论已重算；修订见「复盘」视图。')
        },

        loadAll: () => {
          const s = get()
          const all = s.scenario.batches.map((b) => b.id)
          if (all.every((id) => s.loadedBatchIds.includes(id))) return
          const evidence: EvidenceState = { ...s, loadedBatchIds: all }
          const { analysis, conclusions } = computeAnalysis(evidence, s.manualQuestions)
          set({
            loadedBatchIds: all,
            analysis,
            conclusions,
            snapshots: [...s.snapshots, snapshotOf(conclusions, s.snapshots.length + 1)],
          })
        },

        reset: () => {
          const { analysis, conclusions } = computeAnalysis(initialState, initialState.manualQuestions)
          set({
            ...initialState,
            manualEvents: [],
            manualEdges: [],
            manualCalibrations: [],
            hiddenEdgeIds: [],
            manualQuestions: [],
            loadedBatchIds: [...initialState.loadedBatchIds],
            selection: [],
            hovered: null,
            focusPair: null,
            focusConclusion: null,
            analysis,
            conclusions,
            snapshots: [snapshotOf(conclusions, 1)],
            reviewedAt: {},
            toasts: [],
          })
        },

        addCalibration: (point) => {
          const s = get()
          const cal: CalibrationPoint = {
            ...point,
            id: nextId('manual-cal'),
            batchId: 'manual',
            manual: true,
            createdAt: Date.now(),
          }
          edit({ manualCalibrations: [...s.manualCalibrations, cal] })
          get().toast('ok', '校准点已加入', '原始时间未改动；相关区间已重算。')
        },

        addBreakMarker: (processId, eventId, note) => {
          const s = get()
          const event = s.analysis.eventById.get(eventId)
          if (!event) return
          const exists = s.manualCalibrations.some(
            (c) => c.breakBefore && c.anchorEventId === eventId,
          )
          if (exists) {
            get().toast('warn', '这里已经有跳变标记')
            return
          }
          const cal: CalibrationPoint = {
            id: nextId('manual-break'),
            processId,
            anchorEventId: eventId,
            refTs: null,
            errorMs: 0,
            breakBefore: true,
            source: '人工',
            note: note ?? '复盘时标注的跳变点',
            batchId: 'manual',
            manual: true,
            createdAt: Date.now(),
          }
          edit({ manualCalibrations: [...s.manualCalibrations, cal] })
          get().toast('ok', '跳变点已标注', `${processId}:${event.seq} 之后另起一段时钟，之前的读数不外推过来。`)
        },

        removeCalibration: (id) => {
          const s = get()
          edit({ manualCalibrations: s.manualCalibrations.filter((c) => c.id !== id) })
        },

        addEdge: (from, to, label) => {
          const s = get()
          const edge: CausalEdge = {
            id: nextId('manual-edge'),
            from,
            to,
            kind: 'manual',
            label: label ?? '人工声明的因果',
            batchId: 'manual',
            manual: true,
          }
          const after = edit({ manualEdges: [...s.manualEdges, edge] })
          const cyclic = [...after.graph.cyclicEdgeIds].some((id) => id === edge.id)
          if (cyclic) {
            get().toast('err', '这条边造成了因果环', '它被保留但不会参与排序；请检查两端是否指反了。')
          } else {
            get().toast('ok', '因果边已加入', `${from} → ${to}`)
          }
        },

        removeEdge: (id) => {
          const s = get()
          const isManual = s.manualEdges.some((e) => e.id === id)
          if (isManual) {
            edit({ manualEdges: s.manualEdges.filter((e) => e.id !== id) })
          } else {
            edit({ hiddenEdgeIds: [...s.hiddenEdgeIds, id] })
          }
        },

        addEvent: (event) => {
          const s = get()
          const seq = s.analysis.eventsByProcess.get(event.processId)?.length ?? 0
          const ev: LogEvent = {
            ...event,
            id: `${event.processId}:manual-${nextId('e')}`,
            seq,
            batchId: 'manual',
            manual: true,
          }
          edit({ manualEvents: [...s.manualEvents, ev] })
          get().toast('ok', '日志行已加入', ev.message)
        },

        addQuestion: (a, b, title) => {
          const s = get()
          const q: ScenarioQuestion = {
            id: nextId('manual-q'),
            a,
            b,
            title,
            rationale: '复盘时提出的问题',
            manual: true,
          }
          edit({}, [...s.manualQuestions, q])
        },

        removeQuestion: (id) => {
          const s = get()
          edit({}, s.manualQuestions.filter((q) => q.id !== id))
        },

        select: (id, additive) => {
          const s = get()
          if (additive) {
            const has = s.selection.includes(id)
            set({
              selection: has ? s.selection.filter((x) => x !== id) : [...s.selection, id].slice(-2),
            })
          } else {
            set({
              selection:
                s.selection.length === 1 && s.selection[0] === id ? s.selection : [id],
            })
          }
        },
        clearSelection: () => set({ selection: [] }),
        setHovered: (id) => set({ hovered: id }),
        focusPairIn: (a, b, conclusionId) =>
          set({ focusPair: [a, b], focusConclusion: conclusionId ?? null, view: 'review' }),
        setView: (view) => set({ view }),
        toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
        setLeftOpen: (leftOpen) => set({ leftOpen }),
        setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),

        snapshotReview: () => {
          const s = get()
          set({ snapshots: [...s.snapshots, snapshotOf(s.conclusions, s.snapshots.length + 1)] })
        },

        markReviewed: (id) => {
          const s = get()
          set({ reviewedAt: { ...s.reviewedAt, [id]: new Date().toISOString() } })
        },

        toast: (kind, title, body) => {
          const id = ++counter
          set((s) => ({ toasts: [...s.toasts, { id, kind, title, body }].slice(-4) }))
          setTimeout(() => get().dismissToast(id), 4600)
        },

        dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      }
    },
    {
      name: 'chronoscope-v1',
      // persisted payload is a subset; merge rebuilds derived analysis
      partialize: (s): PersistedState => ({
        loadedBatchIds: s.loadedBatchIds,
        manualEvents: s.manualEvents,
        manualEdges: s.manualEdges,
        manualCalibrations: s.manualCalibrations,
        manualQuestions: s.manualQuestions,
        hiddenEdgeIds: s.hiddenEdgeIds,
        theme: s.theme,
        leftOpen: s.leftOpen,
        inspectorOpen: s.inspectorOpen,
        snapshots: s.snapshots,
        reviewedAt: s.reviewedAt,
      }),
      storage: {
        getItem: (name) => {
          try {
            const raw = localStorage.getItem(name)
            return raw ? JSON.parse(raw) : null
          } catch {
            return null
          }
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, JSON.stringify(value))
          } catch {
            /* quota: ignore */
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedState>
        const evidence: EvidenceState & { manualQuestions: ScenarioQuestion[] } = {
          scenario: current.scenario,
          loadedBatchIds:
            Array.isArray(p.loadedBatchIds) && p.loadedBatchIds.length
              ? p.loadedBatchIds.filter((id) => current.scenario.batches.some((b) => b.id === id))
              : current.loadedBatchIds,
          manualEvents: p.manualEvents ?? [],
          manualEdges: p.manualEdges ?? [],
          manualCalibrations: p.manualCalibrations ?? [],
          hiddenEdgeIds: p.hiddenEdgeIds ?? [],
          manualQuestions: p.manualQuestions ?? [],
        }
        if (evidence.loadedBatchIds.length === 0) evidence.loadedBatchIds = current.loadedBatchIds
        const { analysis, conclusions } = computeAnalysis(evidence, evidence.manualQuestions)
        return {
          ...current,
          ...evidence,
          theme: p.theme ?? current.theme,
          leftOpen: p.leftOpen ?? current.leftOpen,
          inspectorOpen: p.inspectorOpen ?? current.inspectorOpen,
          // There is always at least the initial snapshot; an empty array in
          // storage means "never recorded", not "no conclusions".
          snapshots: p.snapshots?.length ? p.snapshots : current.snapshots,
          reviewedAt: p.reviewedAt ?? {},
          analysis,
          conclusions,
        }
      },
    },
  ),
)

export function diffReviews(
  previous: ReviewSnapshot | undefined,
  current: ReviewSnapshot,
): ReviewChange[] {
  const before = new Map((previous?.conclusions ?? []).map((c) => [c.id, c]))
  const after = new Map(current.conclusions.map((c) => [c.id, c]))
  const out: ReviewChange[] = []
  for (const [id, now] of after) {
    const then = before.get(id)
    if (!then) out.push({ id, title: now.title, status: 'new', after: now })
    else if (then.verdict !== now.verdict || then.statement !== now.statement)
      out.push({ id, title: now.title, status: 'changed', before: then, after: now })
    else out.push({ id, title: now.title, status: 'stable', before: then, after: now })
  }
  for (const [id, then] of before) {
    if (!after.has(id)) out.push({ id, title: then.title, status: 'resolved', before: then })
  }
  const rank: Record<string, number> = { changed: 0, new: 1, resolved: 2, stable: 3 }
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title, 'zh'))
}

export function processColorVar(slot: number): string {
  return `var(--s${(slot % 4) + 1})`
}
