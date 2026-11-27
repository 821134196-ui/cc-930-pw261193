/**
 * Data view: progressive evidence loading, calibration entry, and causal-edge
 * entry. Everything added here is layered on top of the immutable seed data;
 * adding a calibration never touches a raw timestamp.
 */
import { useState } from 'react'
import { useStore } from '../store/store'
import type { CalibrationSource, EventId, ProcessId } from '../domain/types'
import { fmtClock, fmtRel } from '../domain/format'
import { Chip, Empty, SectionHead } from './ui'

const SOURCES: CalibrationSource[] = ['NTP', '抓包', '外部日志', '人工']

export function DataView() {
  const scenario = useStore((s) => s.scenario)
  const loaded = useStore((s) => s.loadedBatchIds)
  const loadBatch = useStore((s) => s.loadBatch)
  const loadAll = useStore((s) => s.loadAll)
  const reset = useStore((s) => s.reset)
  const analysis = useStore((s) => s.analysis)

  const remaining = scenario.batches.filter((b) => !loaded.includes(b.id))

  return (
    <div className="data-view" data-testid="data-view">
      <SectionHead
        title="证据批次"
        hint="日志与因果关系可以逐步补充。每加载一批，结论都会重算，并在「复盘」里显示改写。"
      >
        {remaining.length > 1 && (
          <button className="btn" onClick={loadAll}>
            全部加载
          </button>
        )}
        <button className="btn ghost" onClick={reset}>
          还原示例
        </button>
      </SectionHead>

      <ol className="batch-list">
        {scenario.batches.map((b, i) => {
          const isLoaded = loaded.includes(b.id)
          const eventCount = b.events.length
          const edgeCount = b.edges.length
          const calCount = b.calibrations.length
          return (
            <li key={b.id} className={`batch ${isLoaded ? 'loaded' : ''}`}>
              <div className="batch-index mono">{String(i + 1).padStart(2, '0')}</div>
              <div className="batch-body">
                <div className="batch-top">
                  <strong>{b.title}</strong>
                  <span className="muted small">{b.subtitle}</span>
                  {isLoaded ? (
                    <Chip tone="good">已加载</Chip>
                  ) : (
                    <button className="btn tiny" onClick={() => loadBatch(b.id)}>
                      加载这批
                    </button>
                  )}
                </div>
                <p className="batch-hint muted small">{b.hint}</p>
                <div className="batch-stats">
                  <span className="mono tiny">{eventCount} 条日志</span>
                  <span className="mono tiny">{edgeCount} 条因果边</span>
                  <span className="mono tiny">{calCount} 个校准点</span>
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      <div className="data-grid">
        <CalibrationForm />
        <EdgeForm />
        <EventForm />
        <ProcessSummary />
      </div>

      <ManualEvidence />
      <FullEventTable />
      {analysis.events.length === 0 && <Empty>还没有加载任何事件。</Empty>}
    </div>
  )
}

function CalibrationForm() {
  const analysis = useStore((s) => s.analysis)
  const baseTs = useStore((s) => s.scenario.baseTs)
  const addCalibration = useStore((s) => s.addCalibration)
  const addBreak = useStore((s) => s.addBreakMarker)
  const [processId, setProcessId] = useState<ProcessId>(analysis.processes[0]?.id ?? '')
  const [eventId, setEventId] = useState<EventId>('')
  const [mode, setMode] = useState<'reading' | 'break'>('reading')
  const [refInput, setRefInput] = useState('')
  const [errMs, setErrMs] = useState('15')
  const [source, setSource] = useState<CalibrationSource>('NTP')

  const events = analysis.eventsByProcess.get(processId) ?? []
  const chosen = eventId || events[0]?.id || ''
  const anchor = analysis.eventById.get(chosen)

  const refTs = (() => {
    // Accept either an absolute clock "HH:MM:SS.mmm" or a relative offset
    // "4.050" seconds from the incident base. Both map to epoch ms.
    if (!refInput.trim()) return null
    const abs = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(refInput.trim())
    if (abs) {
      const [, h, m, s, ms] = abs
      const d = new Date(baseTs)
      d.setUTCHours(Number(h), Number(m), Number(s), Number((ms ?? '0').padEnd(3, '0')))
      return d.getTime()
    }
    const sec = Number(refInput)
    if (Number.isFinite(sec)) return Math.round(baseTs + sec * 1000)
    return null
  })()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!chosen) return
    if (mode === 'break') {
      addBreak(processId, chosen)
      return
    }
    if (refTs === null) return
    addCalibration({
      processId,
      anchorEventId: chosen,
      refTs,
      errorMs: Math.max(0, Number(errMs) || 0),
      breakBefore: false,
      source,
      note: '手动补充',
    })
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h3 className="panel-title">补充校准点</h3>
      <p className="panel-hint muted small">
        校准点声明「这个事件在参考时钟上的时刻是 …」。它只改变该进程的<b>偏移估计</b>，不修改任何原始时间戳。
      </p>

      <div className="field-row">
        <label className="field">
          <span>进程</span>
          <select value={processId} onChange={(e) => { setProcessId(e.target.value); setEventId('') }}>
            {analysis.processes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.host}）
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>锚点事件</span>
        <select value={chosen} onChange={(e) => setEventId(e.target.value)}>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.seq} · {e.message} · 原始 {fmtClock(e.rawTs)}
            </option>
          ))}
        </select>
      </label>

      {anchor && (
        <div className="anchor-preview mono small">
          原始时钟 <b>{fmtClock(anchor.rawTs)}</b>
          <span className="muted">（+{fmtRel(anchor.rawTs, baseTs)}）</span>
        </div>
      )}

      <div className="seg full" role="group" aria-label="校准类型">
        <button type="button" className={mode === 'reading' ? 'on' : ''} onClick={() => setMode('reading')}>
          读数
        </button>
        <button type="button" className={mode === 'break' ? 'on' : ''} onClick={() => setMode('break')}>
          仅标跳变
        </button>
      </div>

      {mode === 'reading' ? (
        <>
          <label className="field">
            <span>参考时刻</span>
            <input
              value={refInput}
              onChange={(e) => setRefInput(e.target.value)}
              placeholder="14:03:04.050 或 4.050"
              inputMode="decimal"
            />
            <small className="muted">
              UTC 时刻，或相对基准的秒数（{fmtClock(baseTs)} 起）。
              解析结果：{refTs === null ? '—' : fmtClock(refTs)}
            </small>
          </label>
          <div className="field-row">
            <label className="field narrow">
              <span>误差 ±ms</span>
              <input value={errMs} onChange={(e) => setErrMs(e.target.value)} inputMode="numeric" />
            </label>
            <label className="field">
              <span>来源</span>
              <select value={source} onChange={(e) => setSource(e.target.value as CalibrationSource)}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      ) : (
        <p className="panel-hint small">
          只声明「时钟在这里跳变」，不提供新读数。该点之后的事件会用后续读数重新分段，之前的偏移不会被外推过来。
        </p>
      )}

      <button className="btn primary full" type="submit" disabled={!chosen || (mode === 'reading' && refTs === null)}>
        {mode === 'reading' ? '加入校准点' : '加入跳变标记'}
      </button>
    </form>
  )
}

function EdgeForm() {
  const analysis = useStore((s) => s.analysis)
  const selection = useStore((s) => s.selection)
  const addEdge = useStore((s) => s.addEdge)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [label, setLabel] = useState('')
  const [query, setQuery] = useState('')

  const filtered = query
    ? analysis.events.filter((e) => e.message.includes(query) || e.id.includes(query)).slice(0, 40)
    : analysis.events.slice(0, 40)

  const effFrom = from || selection[0] || ''
  const effTo = to || selection[1] || ''
  const canAdd = effFrom && effTo && effFrom !== effTo

  return (
    <div className="panel">
      <h3 className="panel-title">声明因果关系</h3>
      <p className="panel-hint muted small">
        「A 发生之后，B 才可能发生」。只声明确实存在的事先后关系；同进程内的日志顺序已经自动生效。
      </p>

      <label className="field">
        <span>查找事件</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="按消息或 id 过滤" />
      </label>

      <div className="edge-pickers">
        <EventSelect label="从" value={effFrom} onChange={setFrom} events={filtered} analysis={analysis} />
        <span className="edge-arrow" aria-hidden>→</span>
        <EventSelect label="到" value={effTo} onChange={setTo} events={filtered} analysis={analysis} />
      </div>

      <label className="field">
        <span>说明（可选）</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：authorize 请求" />
      </label>

      <div className="panel-hint small muted">
        选中时间线上的两个事件后，这里会自动填入（按住 Shift 可多选）。
      </div>

      <button
        className="btn primary full"
        disabled={!canAdd}
        onClick={() => {
          addEdge(effFrom, effTo, label || undefined)
          setFrom('')
          setTo('')
          setLabel('')
        }}
      >
        加入因果边
      </button>
    </div>
  )
}

function EventSelect({
  label,
  value,
  onChange,
  events,
  analysis,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  events: ReturnType<typeof useStore.getState>['analysis']['events']
  analysis: ReturnType<typeof useStore.getState>['analysis']
}) {
  return (
    <label className="field compact">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">选择事件…</option>
        {events.map((e) => {
          const p = analysis.processById.get(e.processId)
          return (
            <option key={e.id} value={e.id}>
              {p?.short}:{e.seq} {e.message.slice(0, 34)}
            </option>
          )
        })}
      </select>
    </label>
  )
}

function EventForm() {
  const analysis = useStore((s) => s.analysis)
  const baseTs = useStore((s) => s.scenario.baseTs)
  const addEvent = useStore((s) => s.addEvent)
  const [processId, setProcessId] = useState(analysis.processes[0]?.id ?? '')
  const [rawInput, setRawInput] = useState('')
  const [message, setMessage] = useState('')
  const [kind, setKind] = useState<'log' | 'send' | 'recv' | 'begin' | 'end' | 'error'>('log')

  const rawTs = (() => {
    if (!rawInput.trim()) return null
    const abs = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(rawInput.trim())
    if (abs) {
      const [, h, m, s, ms] = abs
      const d = new Date(baseTs)
      d.setUTCHours(Number(h), Number(m), Number(s), Number((ms ?? '0').padEnd(3, '0')))
      return d.getTime()
    }
    const sec = Number(rawInput)
    if (Number.isFinite(sec)) return Math.round(baseTs + sec * 1000)
    return null
  })()

  const canAdd = rawTs !== null && message.trim().length > 0

  return (
    <div className="panel">
      <h3 className="panel-title">补充一条日志</h3>
      <p className="panel-hint muted small">
        新日志按它自己的原始时钟进入，随时间线一起参与估计；不会改变已有事件的任何时间戳。
      </p>
      <label className="field">
        <span>进程</span>
        <select value={processId} onChange={(e) => setProcessId(e.target.value)}>
          {analysis.processes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>原始时钟时间</span>
        <input value={rawInput} onChange={(e) => setRawInput(e.target.value)} placeholder="14:03:04.050 或 4.050" />
        <small className="muted">解析结果：{rawTs === null ? '—' : fmtClock(rawTs)}</small>
      </label>
      <div className="field-row">
        <label className="field">
          <span>类型</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="log">日志</option>
            <option value="send">发送</option>
            <option value="recv">接收</option>
            <option value="begin">开始</option>
            <option value="end">结束</option>
            <option value="error">错误</option>
          </select>
        </label>
        <label className="field grow">
          <span>内容</span>
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="例如：retry scheduled" />
        </label>
      </div>
      <button
        className="btn primary full"
        disabled={!canAdd}
        onClick={() => {
          addEvent({ processId, rawTs: rawTs!, kind, message: message.trim() })
          setRawInput('')
          setMessage('')
        }}
      >
        加入日志
      </button>
    </div>
  )
}

function ProcessSummary() {
  const analysis = useStore((s) => s.analysis)
  return (
    <div className="panel">
      <h3 className="panel-title">进程摘要</h3>
      <ul className="proc-summary">
        {analysis.processes.map((p) => {
          const model = analysis.clocks.get(p.id)
          const count = analysis.eventsByProcess.get(p.id)?.length ?? 0
          return (
            <li key={p.id}>
              <span className="dot" style={{ background: `var(--s${p.colorSlot + 1})` }} />
              <span className="grow">{p.name}</span>
              <span className="mono tiny muted">{p.host}</span>
              <span className="mono tiny">{count} 事件</span>
              <span className="mono tiny muted">{model?.anchorCount ?? 0} 读数</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ManualEvidence() {
  const manualCals = useStore((s) => s.manualCalibrations)
  const manualEdges = useStore((s) => s.manualEdges)
  const manualEvents = useStore((s) => s.manualEvents)
  const removeCal = useStore((s) => s.removeCalibration)
  const removeEdge = useStore((s) => s.removeEdge)
  const baseTs = useStore((s) => s.scenario.baseTs)

  const total = manualCals.length + manualEdges.length + manualEvents.length
  if (total === 0) return null

  return (
    <section className="manual-evidence">
      <h3 className="panel-title">本次补充的证据</h3>
      <ul className="manual-list">
        {manualCals.map((c) => (
          <li key={c.id}>
            <Chip tone="accent">{c.breakBefore && c.refTs === null ? '跳变标记' : '校准'}</Chip>
            <span className="mono small">{c.anchorEventId}</span>
            {c.refTs !== null && <span className="mono small muted">参考 {fmtRel(c.refTs, baseTs)}</span>}
            <span className="spacer" />
            <button className="btn tiny ghost" onClick={() => removeCal(c.id)}>
              撤回
            </button>
          </li>
        ))}
        {manualEdges.map((e) => (
          <li key={e.id}>
            <Chip tone="accent">因果边</Chip>
            <span className="mono small">
              {e.from} → {e.to}
            </span>
            <span className="small muted">{e.label}</span>
            <span className="spacer" />
            <button className="btn tiny ghost" onClick={() => removeEdge(e.id)}>
              撤回
            </button>
          </li>
        ))}
        {manualEvents.map((e) => (
          <li key={e.id}>
            <Chip tone="accent">日志</Chip>
            <span className="mono small">{e.id}</span>
            <span className="small">{e.message}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FullEventTable() {
  const analysis = useStore((s) => s.analysis)
  const select = useStore((s) => s.select)
  const baseTs = useStore((s) => s.scenario.baseTs)
  return (
    <section className="table-section">
      <h3 className="panel-title">全部事件</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>id</th>
              <th>进程</th>
              <th className="num">seq</th>
              <th>类型</th>
              <th>内容</th>
              <th className="num">原始时钟</th>
              <th className="num">校准估计</th>
              <th className="num">±</th>
            </tr>
          </thead>
          <tbody>
            {analysis.events.map((e) => {
              const est = analysis.estimates.get(e.id)!
              const p = analysis.processById.get(e.processId)
              const width = est.lo === null ? null : est.hi! - est.lo
              return (
                <tr key={e.id} onClick={() => select(e.id)} className="clickable">
                  <td className="mono tiny">{e.id}</td>
                  <td>
                    <span className="dot" style={{ background: `var(--s${(p?.colorSlot ?? 0) + 1})` }} /> {p?.short}
                  </td>
                  <td className="num mono">{e.seq}</td>
                  <td className="small">{e.kind}</td>
                  <td className="small">{e.message}</td>
                  <td className="num mono">{fmtRel(e.rawTs, baseTs)}</td>
                  <td className="num mono">{est.est === null ? '—' : fmtRel(est.est, baseTs)}</td>
                  <td className="num mono muted">{width === null ? '—' : `±${(width / 2).toFixed(1)}`}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
