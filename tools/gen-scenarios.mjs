/**
 * Generates the demo incident dataset.
 *
 * Raw timestamps are produced from a deliberately imperfect clock:
 *   raw(t) = BASE + t + skew + driftPpm*1e-6*t + sum(steps with at <= t)
 *
 * `truth` (ms since BASE) is written alongside so the unit tests can measure the
 * estimator's accuracy. The UI never reads it.
 *
 * The incident:
 *   A ledger fsync stall makes the first authorize take ~4.3s. The gateway times
 *   out at 3.5s (its own deadline) and retries. The retry's idempotency lookup
 *   misses because the first transaction has not committed yet, so the order
 *   service opens a second transaction and both commit: one order, two charges.
 *
 * Clock hazards baked in:
 *   - gw steps +1100ms forward at t=4000 and never notices. No raw timestamp
 *     moves backwards, so only calibration readings can reveal it.
 *   - db steps -2400ms at t=4300; its raw timestamps run backwards between two
 *     log lines. The log order is still correct.
 *   - cache is a loaded VM with a coarse NTP sample (±60ms) and 3000ppm drift,
 *     which keeps some events genuinely unorderable.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../src/data')
mkdirSync(outDir, { recursive: true })

const BASE_TS = Date.UTC(2026, 10, 26, 14, 3, 0)

/** maxStepMs: largest clock jump the process admits to; used to widen extrapolation. */
const PROCESSES = {
  gw: {
    name: 'API 网关', short: 'gw', host: 'edge-01', kind: 'gateway', colorSlot: 0,
    driftBoundPpm: 450, maxStepMs: 1200,
    skew: 2500, driftPpm: 400, steps: [{ at: 4000, delta: 1100 }],
  },
  ord: {
    name: '订单服务', short: 'ord', host: 'app-07', kind: 'service', colorSlot: 1,
    driftBoundPpm: 150, maxStepMs: 12,
    skew: -840, driftPpm: -120, steps: [],
  },
  db: {
    name: '账本数据库', short: 'db', host: 'db-03', kind: 'datastore', colorSlot: 2,
    driftBoundPpm: 1000, maxStepMs: 320,
    skew: 12400, driftPpm: 900, steps: [{ at: 4300, delta: -2400 }],
  },
  cache: {
    name: '库存缓存', short: 'cache', host: 'cache-02', kind: 'cache', colorSlot: 3,
    driftBoundPpm: 500, maxStepMs: 25,
    skew: 620, driftPpm: 400, steps: [],
  },
}

const skewAt = (p, t) => {
  let s = p.skew + p.driftPpm * 1e-6 * t
  for (const step of p.steps) if (t >= step.at) s += step.delta
  return s
}
const rawOf = (p, t) => Math.round(BASE_TS + t + skewAt(p, t))

/** [process, truthOffsetMs, kind, message, requestId?, level?] */
const EVENTS = [
  // ---------- gateway, first attempt ----------
  ['gw', 0, 'recv', 'POST /checkout · r-7f21', 'r-7f21', 'info'],
  ['gw', 8, 'log', 'route → order-svc', 'r-7f21', 'info'],
  ['gw', 12, 'send', 'authorize r-7f21 → ord', 'r-7f21', 'info'],
  ['gw', 3512, 'log', 'upstream ack 超时 3.5s · 排队重试', 'r-7f21', 'error'],
  ['gw', 3990, 'log', '重试退避结束 · 发出', 'r-7f21', 'warn'],
  ['gw', 4050, 'send', 'authorize r-7f21 retry#1 → ord', 'r-7f21', 'warn'],
  ['gw', 4426, 'recv', 'authorize-ok r-7f21', 'r-7f21', 'info'],
  ['gw', 4480, 'recv', 'authorize-ok r-7f21 retry#1', 'r-7f21', 'warn'],
  ['gw', 4486, 'log', '客户端报告重复扣款', 'r-7f21', 'error'],
  ['gw', 4494, 'end', 'POST /checkout 500 · duplicate charge', 'r-7f21', 'error'],

  // ---------- order service ----------
  ['ord', 40, 'recv', 'authorize r-7f21', 'r-7f21', 'info'],
  ['ord', 52, 'log', '幂等键 user-8821:sku-8842 无记录', 'r-7f21', 'info'],
  ['ord', 58, 'send', 'GET stock:sku-8842 → cache', 'r-7f21', 'info'],
  ['ord', 96, 'recv', 'reply HIT stock=12', 'r-7f21', 'info'],
  ['ord', 104, 'log', 'begin tx#4411', 'r-7f21', 'info'],
  ['ord', 108, 'begin', 'tx#4411 opened', 'r-7f21', 'info'],
  ['ord', 118, 'send', 'BEGIN tx#4411 → db', 'r-7f21', 'info'],
  ['ord', 3052, 'log', 'GC pause begin (stop-the-world)', undefined, 'warn'],
  ['ord', 3068, 'log', 'GC pause end · 16ms', undefined, 'warn'],
  ['ord', 4056, 'recv', 'authorize r-7f21 retry#1', 'r-7f21', 'info'],
  ['ord', 4062, 'send', 'GET idem:r-7f21 → cache', 'r-7f21', 'info'],
  ['ord', 4088, 'recv', 'reply MISS', 'r-7f21', 'info'],
  ['ord', 4092, 'log', '幂等复查 MISS，继续下单', 'r-7f21', 'error'],
  ['ord', 4108, 'log', 'begin tx#4412', 'r-7f21', 'info'],
  ['ord', 4112, 'begin', 'tx#4412 opened', 'r-7f21', 'info'],
  ['ord', 4120, 'send', 'BEGIN tx#4412 → db', 'r-7f21', 'info'],
  ['ord', 4398, 'recv', 'COMMIT ok tx#4411', 'r-7f21', 'info'],
  ['ord', 4406, 'end', 'tx#4411 closed', 'r-7f21', 'info'],
  ['ord', 4414, 'send', 'authorize-ok r-7f21 → gw', 'r-7f21', 'info'],
  ['ord', 4458, 'recv', 'COMMIT ok tx#4412', 'r-7f21', 'info'],
  ['ord', 4466, 'end', 'tx#4412 closed', 'r-7f21', 'info'],
  ['ord', 4472, 'send', 'authorize-ok r-7f21 retry#1 → gw', 'r-7f21', 'warn'],
  ['ord', 4478, 'log', '重复订单已落库', 'r-7f21', 'error'],

  // ---------- ledger ----------
  ['db', 140, 'recv', 'BEGIN tx#4411', 'r-7f21', 'info'],
  ['db', 150, 'log', 'lock sku-8842 acquired', 'r-7f21', 'info'],
  ['db', 160, 'log', 'fsync queue depth 12', 'r-7f21', 'warn'],
  ['db', 4000, 'log', 'fsync stall 3.8s · io wait', 'r-7f21', 'warn'],
  ['db', 4140, 'recv', 'BEGIN tx#4412', 'r-7f21', 'info'],
  ['db', 4146, 'log', 'lock wait · row sku-8842 held by tx#4411', 'r-7f21', 'warn'],
  ['db', 4386, 'log', 'commit applied tx#4411', 'r-7f21', 'info'],
  ['db', 4390, 'log', 'lock granted to tx#4412', 'r-7f21', 'info'],
  ['db', 4392, 'send', 'COMMIT ok tx#4411 → ord', 'r-7f21', 'info'],
  ['db', 4450, 'log', 'commit applied tx#4412', 'r-7f21', 'info'],
  ['db', 4454, 'send', 'COMMIT ok tx#4412 → ord', 'r-7f21', 'info'],

  // ---------- cache ----------
  ['cache', 70, 'recv', 'GET stock:sku-8842', 'r-7f21', 'info'],
  ['cache', 76, 'log', 'HIT stock=12', 'r-7f21', 'info'],
  ['cache', 84, 'send', 'reply HIT stock=12 → ord', 'r-7f21', 'info'],
  ['cache', 3000, 'log', 'eviction sweep start (256 keys)', undefined, 'info'],
  ['cache', 3060, 'log', 'eviction sweep done · 31 evicted', undefined, 'info'],
  ['cache', 4070, 'recv', 'GET idem:r-7f21', 'r-7f21', 'info'],
  ['cache', 4074, 'log', 'MISS idem:r-7f21 · 未写入', 'r-7f21', 'warn'],
  ['cache', 4080, 'send', 'reply MISS → ord', 'r-7f21', 'warn'],
  ['cache', 6100, 'log', 'keyspace snapshot persisted', undefined, 'info'],
]

/** [fromKey, toKey, kind, label, batch] with key = `${proc}@${truth}` */
const EDGES = [
  ['gw@12', 'ord@40', 'rpc', 'authorize', 'b1'],
  ['gw@4050', 'ord@4056', 'rpc', 'authorize retry#1', 'b1'],
  ['ord@58', 'cache@70', 'rpc', 'GET stock', 'b2'],
  ['cache@84', 'ord@96', 'reply', 'HIT', 'b2'],
  ['ord@118', 'db@140', 'rpc', 'BEGIN tx#4411', 'b2'],
  ['db@4392', 'ord@4398', 'reply', 'COMMIT ok #4411', 'b2'],
  ['ord@4414', 'gw@4426', 'reply', 'authorize-ok', 'b2'],
  ['ord@4062', 'cache@4070', 'rpc', 'GET idem', 'b2'],
  ['cache@4080', 'ord@4088', 'reply', 'MISS', 'b2'],
  ['ord@4120', 'db@4140', 'rpc', 'BEGIN tx#4412', 'b2'],
  ['db@4454', 'ord@4458', 'reply', 'COMMIT ok #4412', 'b2'],
  ['ord@4472', 'gw@4480', 'reply', 'authorize-ok retry#1', 'b2'],
]

/** [proc, anchorTruth, errMs, breakBefore, source, note|null, batch] */
const CALS = [
  ['gw', 0, 18, false, 'NTP', 'chrony offset sample', 'b1'],
  ['gw', 3512, 18, false, 'NTP', 'chrony offset sample', 'b1'],
  ['ord', 40, 10, false, 'NTP', 'chrony offset sample', 'b1'],
  ['ord', 4120, 10, false, 'NTP', 'chrony offset sample', 'b1'],
  ['db', 140, 25, false, 'NTP', 'chrony offset sample', 'b2'],
  ['db', 4140, 25, false, 'NTP', 'chrony offset sample', 'b2'],
  ['cache', 70, 60, false, 'NTP', 'coarse NTP, VM under load', 'b2'],
  ['gw', 4050, 6, false, '抓包', 'eBPF capture at edge-01', 'b3'],
  ['gw', 4494, 22, false, 'NTP', 'chrony offset sample', 'b3'],
  ['db', 4386, 20, true, '抓包', 'capture shows the clock stepped back before this commit', 'b3'],
  ['cache', 6100, 25, false, '外部日志', 'cache log shipped with ingest timestamp', 'b3'],
]

const QUESTIONS = [
  {
    id: 'retry-before-idem',
    title: '网关重试发送，早于订单服务的幂等复查？',
    a: 'gw@4050', b: 'ord@4092',
    rationale: '若是，重试就是重复扣款的触发条件，幂等复查本应拦住它。',
  },
  {
    id: 'sweep-done-before-gc-end',
    title: '缓存驱逐完成，早于订单服务 GC 暂停结束？',
    a: 'cache@3060', b: 'ord@3068',
    rationale: '两个后台任务互不调用，发生时间几乎重叠；缓存起初只有一次粗校准。',
  },
  {
    id: 'retry-before-commit2',
    title: '网关重试发送，早于账本第二次提交？',
    a: 'gw@4050', b: 'db@4450',
    rationale: '这条链路有完整因果边；账本时钟还会回跳，因果答案不应受影响。',
  },
  {
    id: 'begin2-before-commit1',
    title: '账本第二次 BEGIN，早于第一次 COMMIT 回执？',
    a: 'db@4140', b: 'db@4392',
    rationale: '同一进程的日志顺序说「是」，但那台机器的原始时钟却往回走了一大截。',
  },
  {
    id: 'sweep-before-timeout',
    title: '缓存驱逐完成，早于网关的 3.5s 超时？',
    a: 'cache@3060', b: 'gw@3512',
    rationale: '两者没有因果关系。第一批日志里缓存还不存在，答案要等第二批。',
  },
]

const BATCHES = [
  { id: 'b1', title: '应用日志', subtitle: '网关 + 订单服务', hint: '只有两端，下游还看不见' },
  { id: 'b2', title: '下游日志', subtitle: '账本 + 库存缓存', hint: '链路补全，时钟问题开始显形' },
  { id: 'b3', title: '外部证据', subtitle: '抓包 + 第二组 NTP', hint: '定位跳变，重算此前结论' },
]

/* ---------------- build ---------------- */

const events = []
const truth = {}
const keyToId = new Map()
const seqByProc = new Map()
for (const [processId, t, kind, message, requestId, level] of EVENTS) {
  const seq = seqByProc.get(processId) ?? 0
  seqByProc.set(processId, seq + 1)
  const id = `${processId}:${seq}`
  keyToId.set(`${processId}@${t}`, id)
  truth[id] = t
  events.push({
    id, processId, seq, rawTs: rawOf(PROCESSES[processId], t), kind, message,
    ...(requestId ? { requestId } : {}),
    ...(level ? { level } : {}),
  })
}

const edges = EDGES.map(([from, to, kind, label, batchId], i) => {
  const f = keyToId.get(from)
  const t = keyToId.get(to)
  if (!f || !t) throw new Error(`bad edge ${from} -> ${to}`)
  return { id: `edge-${String(i + 1).padStart(2, '0')}`, from: f, to: t, kind, label, batchId }
})

const calibrations = CALS.map(([processId, t, errorMs, breakBefore, source, note, batchId], i) => {
  const anchor = keyToId.get(`${processId}@${t}`)
  if (!anchor) throw new Error(`bad calibration anchor ${processId}@${t}`)
  return {
    id: `cal-${String(i + 1).padStart(2, '0')}-${processId}`,
    processId, anchorEventId: anchor, refTs: BASE_TS + t, errorMs, breakBefore,
    source, ...(note ? { note } : {}), batchId,
  }
})

const questions = QUESTIONS.map((q) => ({
  ...q, a: keyToId.get(q.a), b: keyToId.get(q.b),
}))

const scenario = {
  id: 'payments',
  title: '支付确认超时 · 重复扣款',
  subtitle: '四进程 · 一次重试抢在幂等落库之前 · 三批证据逐步到位',
  incident:
    '14:03:00 UTC checkout r-7f21 被扣款两次。网关在 3.5s 客户端超时后重发 authorize；' +
    '账本的 fsync 停顿让第一次事务迟迟未提交，重试的幂等复查因此 MISS，' +
    '两个事务先后提交。两台机器的时钟在此期间还各自跳过。',
  baseTs: BASE_TS,
  referenceClock: 'UTC（抓包机 / chrony）',
  processes: Object.entries(PROCESSES).map(([id, p]) => ({
    id, name: p.name, short: p.short, host: p.host, kind: p.kind,
    colorSlot: p.colorSlot, driftBoundPpm: p.driftBoundPpm, maxStepMs: p.maxStepMs,
  })),
  batches: BATCHES.map((b) => ({
    ...b,
    events: events.filter((e) => e.batchId === undefined || e.batchId === b.id)
      .filter(() => true),
    edges: edges.filter((e) => e.batchId === b.id),
    calibrations: calibrations.filter((c) => c.batchId === b.id),
  })),
  questions,
  truth,
}

// distribute events into batches: b1 = gw+ord, b2 = db+cache, b3 = none
const membership = {}
for (const [proc, batchId] of Object.entries({ gw: 'b1', ord: 'b1', db: 'b2', cache: 'b2' })) {
  for (const e of events) if (e.processId === proc) membership[e.id] = batchId
}
for (const b of scenario.batches) {
  b.events = events
    .filter((e) => membership[e.id] === b.id)
    .map((e) => ({ ...e, batchId: b.id }))
}

writeFileSync(resolve(outDir, 'payments.json'), JSON.stringify(scenario, null, 2) + '\n')

/* ---------------- sanity report ---------------- */
let failures = 0
const fail = (msg) => {
  failures++
  console.error('  ✗ ' + msg)
}
console.log(`wrote src/data/payments.json · ${events.length} events · ${edges.length} edges · ${calibrations.length} calibrations`)
for (const [id, p] of Object.entries(PROCESSES)) {
  const rows = events.filter((e) => e.processId === id)
  let back = 0
  for (let i = 1; i < rows.length; i++) back = Math.min(back, rows[i].rawTs - rows[i - 1].rawTs)
  console.log(
    `  ${id.padEnd(5)} n=${String(rows.length).padStart(2)} ` +
      `skew ${skewAt(p, 0).toFixed(0)}→${skewAt(p, rows[rows.length - 1].rawTs - BASE_TS).toFixed(0)}ms ` +
      `rawBack=${back}ms`,
  )
}
for (const e of edges) {
  const a = events.find((x) => x.id === e.from)
  const b = events.find((x) => x.id === e.to)
  if (!(truth[e.from] < truth[e.to])) fail(`edge ${e.id} not forward in truth time`)
  if (a.processId === b.processId) console.log(`  note: intra-process edge ${e.id}`)
}
for (const c of calibrations) {
  const a = events.find((x) => x.id === c.anchorEventId)
  const err = c.refTs - (BASE_TS + truth[c.anchorEventId])
  if (err !== 0) fail(`calibration ${c.id} refTs is off by ${err}ms`)
  if (a.processId !== c.processId) fail(`calibration ${c.id} anchored on the wrong process`)
}
for (const q of questions) {
  if (!q.a || !q.b) fail(`question ${q.id} references a missing event`)
}
const ids = new Set(events.map((e) => e.id))
for (const e of edges) if (!ids.has(e.from) || !ids.has(e.to)) fail(`edge ${e.id} dangles`)
console.log(failures === 0 ? '  all integrity checks passed' : `  ${failures} integrity failure(s)`)
if (failures > 0) process.exitCode = 1
