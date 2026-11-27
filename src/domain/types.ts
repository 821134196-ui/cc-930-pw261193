/** Core data model for the incident post-mortem analyzer. */

export type ProcessId = string
export type EventId = string
export type CalibrationId = string

export type ProcessKind = 'gateway' | 'service' | 'datastore' | 'cache'

export interface ProcessInfo {
  id: ProcessId
  name: string
  short: string
  host: string
  kind: ProcessKind
  /** categorical palette slot, fixed per process (never re-assigned) */
  colorSlot: number
  /** assumed max clock rate error, parts per million */
  driftBoundPpm: number
  /** largest clock step the process admits to; always added to extrapolations */
  maxStepMs: number
}

export type EventKind = 'log' | 'send' | 'recv' | 'begin' | 'end' | 'error'

export interface LogEvent {
  id: EventId
  processId: ProcessId
  /** position in the process's own log; the authoritative local order */
  seq: number
  /** epoch ms exactly as recorded on that machine's clock. Never rewritten. */
  rawTs: number
  kind: EventKind
  message: string
  requestId?: string
  level?: 'info' | 'warn' | 'error'
  batchId?: string
  manual?: boolean
}

export type EdgeKind = 'rpc' | 'reply' | 'async' | 'manual' | 'log'

export interface CausalEdge {
  id: string
  from: EventId
  to: EventId
  kind: EdgeKind
  label: string
  batchId?: string
  manual?: boolean
  /** derived from the process's own log order rather than supplied */
  implied?: boolean
}

export type CalibrationSource = 'NTP' | '抓包' | '外部日志' | '人工' | '未标注'

export interface CalibrationPoint {
  id: CalibrationId
  processId: ProcessId
  /** the event whose reference time was observed */
  anchorEventId: EventId
  /**
   * Reference-clock epoch ms at the anchor event.
   * `null` marks a break-only marker: it declares a jump without giving a new
   * absolute reading.
   */
  refTs: number | null
  /** symmetric uncertainty of the reference reading, ms (0 for break-only) */
  errorMs: number
  /** a jump happened at the anchor: no offset is carried across this point */
  breakBefore: boolean
  source: CalibrationSource
  note?: string
  batchId?: string
  manual?: boolean
  createdAt?: number
}

export interface Batch {
  id: string
  title: string
  subtitle: string
  hint: string
  events: LogEvent[]
  edges: CausalEdge[]
  calibrations: CalibrationPoint[]
}

export interface ScenarioQuestion {
  id: string
  title: string
  a: EventId
  b: EventId
  rationale: string
  manual?: boolean
}

export interface Scenario {
  id: string
  title: string
  subtitle: string
  incident: string
  baseTs: number
  referenceClock: string
  processes: ProcessInfo[]
  batches: Batch[]
  questions: ScenarioQuestion[]
  truth?: Record<EventId, number>
}

/* ---------- clock model ---------- */

export type EstimateBasis = 'none' | 'anchored' | 'interpolated' | 'extrapolated'

export interface ClockEstimate {
  rawTs: number
  /** point estimate of reference time; null when the segment has no reading */
  est: number | null
  lo: number | null
  hi: number | null
  basis: EstimateBasis
  offsetEst: number | null
  /** calibration ids that bracket the event (either side may be null) */
  bracket: [CalibrationId | null, CalibrationId | null]
  segmentIndex: number
  /** the two bracketing readings disagree beyond drift: a jump hides between them */
  spanUncertain: boolean
  /** this event's segment has no reading at all */
  unplaced: boolean
}

/** A clock step: declared by a segment boundary or revealed by readings. */
export interface ClockJump {
  id: string
  processId: ProcessId
  beforeEventId: EventId | null
  afterEventId: EventId
  beforeCalibrationId: CalibrationId | null
  afterCalibrationId: CalibrationId | null
  /** offset change across the gap, ms (0 for break-only markers) */
  deltaMs: number
  /** largest change the drift bound can explain, ms */
  boundMs: number
  /** the step is visible in the raw log itself (time ran backwards) */
  fromRawBackwards: boolean
  declared: boolean
  message: string
}

export interface ClockModel {
  processId: ProcessId
  calibrated: boolean
  anchorCount: number
  segmentCount: number
  segments: {
    index: number
    startSeq: number
    calibrationIds: CalibrationId[]
    hasReading: boolean
  }[]
  jumps: ClockJump[]
  /** per-event estimates, keyed by event id */
  estimate: (event: LogEvent) => ClockEstimate
}

/* ---------- causal graph ---------- */

export interface CausalGraph {
  outgoing: Map<EventId, CausalEdge[]>
  incoming: Map<EventId, CausalEdge[]>
  /** happens-before reachability: explicit edges + per-process log order */
  descendants: Map<EventId, Set<EventId>>
  /** explicit edges only, for cycle reporting */
  cycles: EventId[][]
  cyclicEdgeIds: Set<string>
  /** shortest causal chain from a to b, or null */
  path: (a: EventId, b: EventId) => EventId[] | null
}

/* ---------- analysis ---------- */

export type OrderKind = 'a-before-b' | 'b-before-a' | 'concurrent' | 'unknown'

export interface Relation {
  kind: OrderKind
  /** strongest evidence actually used */
  via: 'causal' | 'log' | 'clock' | 'none'
  causalKind: OrderKind | null
  clockKind: OrderKind | null
  /** causal and clock evidence disagree */
  conflict: boolean
  overlapLo: number | null
  overlapHi: number | null
  /** for conflicts: distance between the two intervals, ms */
  gapMs: number
  causalReason?: string
  clockReason?: string
  /** causal chain when the ordering came from reachability */
  chain?: EventId[]
  /** one of the two events does not exist */
  missing?: boolean
}

export type ConflictKind =
  | 'raw-backwards'
  | 'edge-vs-log'
  | 'edge-vs-clock'
  | 'cycle'
  | 'undeclared-jump'

export interface Conflict {
  id: string
  kind: ConflictKind
  a: EventId
  b: EventId
  edgeId?: string
  processId?: ProcessId
  gapMs: number
  message: string
}

export interface RawBackwards {
  from: LogEvent
  to: LogEvent
  delta: number
}

export interface Analysis {
  processes: ProcessInfo[]
  events: LogEvent[]
  eventsByProcess: Map<ProcessId, LogEvent[]>
  eventById: Map<EventId, LogEvent>
  processById: Map<ProcessId, ProcessInfo>
  edges: CausalEdge[]
  explicitEdges: CausalEdge[]
  calibrations: CalibrationPoint[]
  clocks: Map<ProcessId, ClockModel>
  estimates: Map<EventId, ClockEstimate>
  graph: CausalGraph
  conflicts: Conflict[]
  jumps: ClockJump[]
  rawBackwards: RawBackwards[]
  unpairedSends: EventId[]
  orphanRecvs: EventId[]
  /** events grouped into tiers of pairwise-overlapping intervals, earliest first */
  tiers: EventId[][]
  unplaced: EventId[]
  /** events whose interval overlaps the given event and that are not causally ordered with it */
  concurrentWith: (id: EventId) => EventId[]
}

export type Verdict = 'hold' | 'open' | 'conflict' | 'info'

export interface ConclusionAction {
  kind: 'mark-jump' | 'add-calibration' | 'open-evidence'
  label: string
  processId?: ProcessId
  eventId?: EventId
}

export interface Conclusion {
  id: string
  group: 'question' | 'edge' | 'clock' | 'evidence'
  title: string
  statement: string
  verdict: Verdict
  detail: string
  events: EventId[]
  processId?: ProcessId
  action?: ConclusionAction
}

export type ReviewStatus = 'new' | 'stable' | 'changed' | 'resolved'

export interface ConclusionSnapshot {
  id: string
  title: string
  statement: string
  verdict: Verdict
  events: EventId[]
}

export interface ReviewSnapshot {
  version: number
  at: number
  conclusions: ConclusionSnapshot[]
}

export interface ReviewChange {
  id: string
  title: string
  status: ReviewStatus
  before?: ConclusionSnapshot
  after?: ConclusionSnapshot
}
