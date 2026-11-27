/** Review view: the conclusion ledger, plus what the latest evidence changed. */
import { useMemo } from 'react'
import { useStore, diffReviews } from '../store/store'
import type { Conclusion, Verdict } from '../domain/types'
import { SectionHead, VerdictChip, Chip, Empty } from './ui'
import { fmtClock } from '../domain/format'

const GROUPS: { key: Conclusion['group']; title: string; hint: string }[] = [
  { key: 'question', title: '待证问题', hint: '每个问题都用最强证据回答；证据不足时如实说明，不硬排。' },
  { key: 'clock', title: '时钟', hint: '跳变点、未声明的偏移变化。' },
  { key: 'edge', title: '因果与证据缺口', hint: '因果边与时钟/日志的矛盾，以及尚未声明的去向。' },
  { key: 'evidence', title: '数据完整性', hint: '缺少校准或缺少因果的事件集合。' },
]

export function ReviewView() {
  const conclusions = useStore((s) => s.conclusions)
  const snapshots = useStore((s) => s.snapshots)
  const focusConclusion = useStore((s) => s.focusConclusion)
  const reviewedAt = useStore((s) => s.reviewedAt)
  const markReviewed = useStore((s) => s.markReviewed)
  const current = snapshots[snapshots.length - 1]
  const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2] : undefined
  const changes = useMemo(() => diffReviews(previous, current), [previous, current])
  const changed = changes.filter((c) => c.status === 'changed' || c.status === 'new' || c.status === 'resolved')


  return (
    <div className="review-view" data-testid="review-view">
      <SectionHead
        title="复盘台账"
        hint="每次加入证据或校准点都会留下一个快照。这里显示最近一次证据变化改写了哪些结论。"
      />

      <div className="review-delta">
        <div className="delta-head">
          <div>
            <h3>最近一次修订</h3>
            <p className="muted small">
              {previous
                ? `快照 v${previous.version} → v${current.version} · ${new Date(current.at).toLocaleTimeString('zh-CN', { hour12: false })}`
                : '尚无前序快照'}
            </p>
          </div>
          <div className="delta-counts">
            <span className="count-pill changed">{changes.filter((c) => c.status === 'changed').length} 改写</span>
            <span className="count-pill new">{changes.filter((c) => c.status === 'new').length} 新增</span>
            <span className="count-pill resolved">{changes.filter((c) => c.status === 'resolved').length} 解决</span>
            <span className="count-pill stable">{changes.filter((c) => c.status === 'stable').length} 不变</span>
          </div>
        </div>
        {changed.length === 0 ? (
          <Empty>这次快照没有改写任何结论。</Empty>
        ) : (
          <ul className="delta-list">
            {changed.slice(0, 8).map((c) => (
              <li key={c.id} className={`delta-item ${c.status}`}>
                <span className={`delta-tag ${c.status}`}>
                  {c.status === 'changed' ? '改写' : c.status === 'new' ? '新增' : '解决'}
                </span>
                <div className="delta-body">
                  <strong>{c.title}</strong>
                  {c.status === 'changed' && c.before && c.after && (
                    <div className="delta-diff">
                      <span className="diff-before">
                        <VerdictChip verdict={c.before.verdict} /> {c.before.statement}
                      </span>
                      <span className="diff-arrow" aria-hidden>→</span>
                      <span className="diff-after">
                        <VerdictChip verdict={c.after.verdict} /> {c.after.statement}
                      </span>
                    </div>
                  )}
                  {c.status === 'new' && c.after && (
                    <span className="small muted">
                      <VerdictChip verdict={c.after.verdict} /> {c.after.statement}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {GROUPS.map((g) => {
        const items = conclusions.filter((c) => c.group === g.key)
        if (items.length === 0) return null
        return (
          <section key={g.key} className="review-group">
            <div className="group-head">
              <h3>{g.title}</h3>
              <span className="count">{items.length}</span>
              <p className="muted small">{g.hint}</p>
            </div>
            <ul className="conclusion-list">
              {items.map((c) => (
                <ConclusionCard
                  key={c.id}
                  conclusion={c}
                  highlighted={focusConclusion === c.id}
                  reviewedAt={reviewedAt[c.id]}
                  onReview={() => markReviewed(c.id)}
                />
              ))}
            </ul>
          </section>
        )
      })}
      {conclusions.length === 0 && <Empty>没有结论。</Empty>}

      <details className="history">
        <summary>
          <strong>快照历史</strong>
          <span className="muted small">{snapshots.length} 个</span>
        </summary>
        <ol className="history-list">
          {[...snapshots].reverse().map((s) => {
            const vc = new Map(s.conclusions.map((c) => [c.id, c.verdict] as const))
            const count = (v: Verdict) => [...vc.values()].filter((x) => x === v).length
            return (
              <li key={s.version}>
                <span className="mono">v{s.version}</span>
                <span className="muted small">{new Date(s.at).toLocaleString('zh-CN', { hour12: false })}</span>
                <span className="spacer" />
                <Chip tone="good">{count('hold')} 成立</Chip>
                <Chip tone="warn">{count('open')} 未定</Chip>
                <Chip tone="bad">{count('conflict')} 冲突</Chip>
                <Chip tone="info">{count('info')} 提示</Chip>
              </li>
            )
          })}
        </ol>
      </details>
    </div>
  )
}

function ConclusionCard({
  conclusion,
  highlighted,
  reviewedAt,
  onReview,
}: {
  conclusion: Conclusion
  highlighted: boolean
  reviewedAt?: string
  onReview: () => void
}) {
  const analysis = useStore((s) => s.analysis)
  const select = useStore((s) => s.select)
  const addBreak = useStore((s) => s.addBreakMarker)
  const focusPairIn = useStore((s) => s.focusPairIn)
  const setView = useStore((s) => s.setView)

  const events = conclusion.events.map((id) => analysis.eventById.get(id)).filter(Boolean)

  return (
    <li className={`conclusion ${conclusion.verdict} ${highlighted ? 'highlighted' : ''}`} data-conclusion={conclusion.id}>
      <div className="conclusion-head">
        <VerdictChip verdict={conclusion.verdict} />
        <h4>{conclusion.title}</h4>
        <span className="spacer" />
        {reviewedAt && <span className="muted tiny">已复核</span>}
      </div>
      <p className="conclusion-statement">{conclusion.statement}</p>
      <p className="conclusion-detail muted small">{conclusion.detail}</p>

      <div className="conclusion-foot">
        <div className="conclusion-events">
          {events.map((e) => (
            <button
              key={e!.id}
              className="ev-chip"
              onClick={() => select(e!.id)}
              title={e!.message}
            >
              <span className="dot" style={{ background: `var(--s${(analysis.processById.get(e!.processId)?.colorSlot ?? 0) + 1})` }} />
              <span className="mono tiny">{e!.id}</span>
              <span className="tiny muted">{fmtClock(e!.rawTs)}</span>
            </button>
          ))}
        </div>
        <div className="conclusion-actions">
          {conclusion.events.length === 2 && (
            <button
              className="btn tiny ghost"
              onClick={() => focusPairIn(conclusion.events[0], conclusion.events[1], conclusion.id)}
            >
              对比两者
            </button>
          )}
          {conclusion.action?.kind === 'mark-jump' && conclusion.processId && conclusion.events[1] && (
            <button className="btn tiny ghost" onClick={() => addBreak(conclusion.processId!, conclusion.events[1])}>
              标注跳变点
            </button>
          )}
          {conclusion.events.includes(analysis.unplaced[0]) && (
            <button className="btn tiny ghost" onClick={() => setView('clock')}>
              查看时钟
            </button>
          )}
          <button className="btn tiny ghost" onClick={onReview}>
            标记已复核
          </button>
        </div>
      </div>
    </li>
  )
}
