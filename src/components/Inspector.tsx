/**
 * Inspector: everything known about the selected event(s), including the exact
 * pairwise relation when two are selected.
 */
import { useStore } from '../store/store'
import { relate } from '../domain/analysis'
import type { EventId } from '../domain/types'
import { fmt, fmtClock, fmtRel, fmtSigned, BASIS_LABEL, EVENT_KIND_LABEL } from '../domain/format'
import { Chip, Kbd, VerdictChip } from './ui'

export function Inspector() {
  const selection = useStore((s) => s.selection)
  const analysis = useStore((s) => s.analysis)
  const clearSelection = useStore((s) => s.clearSelection)
  const baseTs = useStore((s) => s.scenario.baseTs)

  if (selection.length === 0) return <InspectorEmpty />

  const events = selection
    .map((id) => analysis.eventById.get(id))
    .filter((e): e is NonNullable<typeof e> => !!e)
  const pair = events.length === 2 ? relate(events[0].id, events[1].id, analysis) : null

  return (
    <div className="inspector" data-testid="inspector">
      <div className="inspector-head">
        <h2>{events.length === 1 ? '事件详情' : '两事件关系'}</h2>
        <button className="btn tiny ghost" onClick={clearSelection}>
          清除
        </button>
      </div>

      {pair && <PairRelation pair={pair} />}

      <div className="inspector-events">
        {events.map((e, idx) => {
          const est = analysis.estimates.get(e.id)!
          const p = analysis.processById.get(e.processId)!
          const outgoing = analysis.explicitEdges.filter((x) => x.from === e.id)
          const incoming = analysis.explicitEdges.filter((x) => x.to === e.id)
          return (
            <div key={e.id} className="inspector-event" data-event={e.id}>
              <div className="ie-head">
                <span className="dot" style={{ background: `var(--s${p.colorSlot + 1})` }} />
                <strong>{p.name}</strong>
                <span className="mono tiny muted">{p.host}</span>
                {pair && <span className="pair-badge">{idx === 0 ? 'A' : 'B'}</span>}
              </div>
              <p className="ie-message">{e.message}</p>
              <dl className="ie-facts">
                <dt>事件</dt>
                <dd className="mono">{e.id}</dd>
                <dt>日志序号</dt>
                <dd className="mono">seq {e.seq}</dd>
                <dt>类型</dt>
                <dd>{EVENT_KIND_LABEL[e.kind]}</dd>
                {e.requestId && (
                  <>
                    <dt>请求</dt>
                    <dd className="mono">{e.requestId}</dd>
                  </>
                )}
              </dl>

              <div className="ie-clock">
                <div className="clock-row">
                  <span className="clock-label">原始时钟</span>
                  <span className="mono">{fmtClock(e.rawTs)}</span>
                  <span className="muted tiny">{fmtRel(e.rawTs, baseTs)}</span>
                </div>
                {est.lo !== null && est.hi !== null ? (
                  <>
                    <div className="clock-row">
                      <span className="clock-label">校准估计</span>
                      <span className="mono">
                        {est.est === null ? '不给点估计' : fmtClock(est.est)}
                      </span>
                      {est.est !== null && (
                        <span className="muted tiny">{fmtRel(est.est, baseTs)}</span>
                      )}
                    </div>
                    <div className="clock-row">
                      <span className="clock-label">区间</span>
                      <span className="mono small">
                        {fmtRel(est.lo, baseTs)} … {fmtRel(est.hi, baseTs)}
                      </span>
                    </div>
                    <div className="clock-row">
                      <span className="clock-label">区间宽度</span>
                      <span className="mono small">{fmt(est.hi - est.lo)}</span>
                    </div>
                    <div className="clock-row">
                      <span className="clock-label">依据</span>
                      <span className="small">
                        {BASIS_LABEL[est.basis]} · 第 {est.segmentIndex + 1} 段
                        {est.spanUncertain && (
                          <Chip tone="bad" title="两侧读数之间的矛盾超过漂移上限，中间可能藏着一次跳变">
                            含未标注跳变
                          </Chip>
                        )}
                      </span>
                    </div>
                    {est.offsetEst !== null && (
                      <div className="clock-row">
                        <span className="clock-label">偏移</span>
                        <span className="mono small">{fmtSigned(est.offsetEst)}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="clock-row">
                    <span className="clock-label">校准估计</span>
                    <span className="small">
                      <Chip tone="bad">该时钟段没有读数</Chip>
                      <span className="muted tiny"> 不参与跨进程排序</span>
                    </span>
                  </div>
                )}
                {(est.bracket[0] || est.bracket[1]) && (
                  <div className="clock-row">
                    <span className="clock-label">依据读数</span>
                    <span className="mono tiny">
                      {[est.bracket[0], est.bracket[1]].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                )}
              </div>

              {(incoming.length > 0 || outgoing.length > 0) && (
                <div className="ie-edges">
                  <h4>因果边</h4>
                  <ul>
                    {incoming.map((x) => (
                      <li key={x.id}>
                        <span className="mono tiny">{x.from}</span>
                        <span className="muted"> → 本事件</span>
                        <span className="muted tiny"> {x.label}</span>
                      </li>
                    ))}
                    {outgoing.map((x) => (
                      <li key={x.id}>
                        <span className="muted">本事件 → </span>
                        <span className="mono tiny">{x.to}</span>
                        <span className="muted tiny"> {x.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ORDER_LABEL = {
  'a-before-b': 'A 早于 B',
  'b-before-a': 'B 早于 A',
  concurrent: '同一时间（不可定序）',
  unknown: '无法判断',
} as const

/**
 * A causal path can be a dozen hops long. Show only the *process* it passes
 * through, collapsing consecutive events on the same machine, with the full
 * chain available on hover — the point is "which services are in the middle",
 * not the individual log lines.
 */
function Chain({ path }: { path: EventId[] }) {
  const analysis = useStore((s) => s.analysis)
  const runs: { name: string; colorSlot: number; first: EventId; last: EventId; count: number }[] = []
  for (const id of path) {
    const e = analysis.eventById.get(id)
    const p = e ? analysis.processById.get(e.processId) : undefined
    const name = p?.short ?? '?'
    const last = runs[runs.length - 1]
    if (last && last.name === name) {
      last.last = id
      last.count += 1
    } else {
      runs.push({ name, colorSlot: p?.colorSlot ?? 0, first: id, last: id, count: 1 })
    }
  }

  return (
    <span className="chain" title={path.join(' → ')}>
      {runs.map((run, i) => (
        <span key={`${run.first}-${i}`} className="chain-run">
          {i > 0 && <span className="chain-arrow" aria-hidden>→</span>}
          <span className="chain-dot" style={{ background: `var(--s${(run.colorSlot % 4) + 1})` }} />
          <span className="mono">{run.name}</span>
          {run.count > 1 && <span className="muted">×{run.count}</span>}
        </span>
      ))}
      <span className="visually-hidden">{path.join(' → ')}</span>
    </span>
  )
}

function PairRelation({ pair }: { pair: ReturnType<typeof relate> }) {
  const tone = pair.conflict
    ? 'conflict'
    : pair.kind === 'concurrent' || pair.kind === 'unknown'
      ? 'open'
      : 'hold'

  return (
    <div className={`pair-relation ${tone}`} data-testid="pair-relation">
      <div className="pair-verdict">
        <VerdictChip verdict={tone} />
        <strong>{pair.conflict ? '因果与时钟冲突' : ORDER_LABEL[pair.kind]}</strong>
      </div>

      <div className="pair-evidence">
        <span className="pe-label">因果</span>
        <span className="small">
          {pair.causalKind ? (
            <>
              {ORDER_LABEL[pair.causalKind]}
              <span className="block muted tiny">{pair.causalReason}</span>
              {pair.chain && pair.chain.length > 2 && <Chain path={pair.chain} />}
            </>
          ) : (
            <span className="muted">两者之间没有因果路径，只能靠时间</span>
          )}
        </span>
      </div>

      <div className="pair-evidence">
        <span className="pe-label">时钟</span>
        <span className="small">
          {pair.clockKind === null ? (
            <span className="muted">{pair.clockReason ?? '没有可用的时间区间'}</span>
          ) : pair.clockKind === 'concurrent' ? (
            <span className="muted">{pair.clockReason ?? '区间重叠，不能定序'}</span>
          ) : (
            <span>{pair.clockReason}</span>
          )}
        </span>
      </div>

      {pair.overlapLo !== null && pair.overlapHi !== null && (
        <div className="pair-overlap mono tiny">
          重叠窗口 {fmtClock(pair.overlapLo)} – {fmtClock(pair.overlapHi)}（
          {fmt(pair.overlapHi - pair.overlapLo)}）
        </div>
      )}

      {pair.gapMs > 0 && (
        <div className="pair-overlap mono tiny">两侧间隔 {fmt(pair.gapMs)}</div>
      )}

      <p className="pair-guidance small muted">
        {pair.conflict
          ? '因果与时钟不可能同时正确。检查两台机器的校准读数，或检查因果边是否指错了事件。'
          : pair.kind === 'concurrent' || pair.kind === 'unknown'
            ? '证据不足以定序。补充校准点（收窄区间）或因果边（给出直接证据）后重算。'
            : '这一顺序由最强证据给出；若加入新校准，结论会重新评估。'}
      </p>
    </div>
  )
}

function InspectorEmpty() {
  const analysis = useStore((s) => s.analysis)
  const conclusions = useStore((s) => s.conclusions)
  const hovered = useStore((s) => s.hovered)
  const conflicts = conclusions.filter((c) => c.verdict === 'conflict').length
  const open = conclusions.filter((c) => c.verdict === 'open').length
  const select = useStore((s) => s.select)
  const hoveredEvent = hovered ? analysis.eventById.get(hovered) : null

  return (
    <div className="inspector inspector-empty" data-testid="inspector">
      <div className="inspector-head">
        <h2>检查器</h2>
      </div>
      {hoveredEvent ? (
        <div className="hover-preview">
          <p className="small muted">悬停中 · 点击可选中</p>
          <p className="ie-message">{hoveredEvent.message}</p>
          <p className="mono tiny muted">
            {hoveredEvent.id} · 原始 {fmtClock(hoveredEvent.rawTs)}
          </p>
          <button className="btn tiny" onClick={() => select(hoveredEvent.id)}>
            选中查看详情
          </button>
        </div>
      ) : (
        <div className="empty-hint">
          <p>点击时间线上的事件查看详情。</p>
          <p className="muted small">
            再按住 <Kbd>Shift</Kbd> 点选第二个事件，这里会显示两者的关系：
            因果是否成立、时钟区间是否重叠、有没有冲突。
          </p>
          <div className="hint-stats">
            <Stat label="事件" value={analysis.events.length} />
            <Stat label="因果边" value={analysis.explicitEdges.length} />
            <Stat label="冲突结论" value={conflicts} tone={conflicts ? 'bad' : undefined} />
            <Stat label="未定序" value={analysis.unplaced.length} />
          </div>
          {open > 0 && (
            <p className="muted tiny">
              {open} 条结论尚无定论。证据不足时如实显示区间，不硬排。
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' }) {
  return (
    <div className={`mini-stat ${tone ?? ''}`}>
      <span className="mini-stat-value tnum">{value}</span>
      <span className="mini-stat-label">{label}</span>
    </div>
  )
}
