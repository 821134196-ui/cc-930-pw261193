/**
 * App shell: header, evidence rail, the four views, and the inspector.
 */
import { useEffect, useMemo } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Clock3,
  Database,
  ListChecks,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Sun,
  X,
} from 'lucide-react'
import { useStore, diffReviews, type View } from './store/store'
import { Timeline } from './components/Timeline'
import { ClockView } from './components/ClockView'
import { ReviewView } from './components/ReviewView'
import { DataView } from './components/DataView'
import { Inspector } from './components/Inspector'
import { processColorVar } from './store/store'
import { fmtClock } from './domain/format'
import { Chip } from './components/ui'

const VIEWS: { id: View; label: string; icon: typeof Clock3 }[] = [
  { id: 'timeline', label: '时间线', icon: Clock3 },
  { id: 'clock', label: '时钟', icon: Database },
  { id: 'review', label: '复盘', icon: ListChecks },
  { id: 'data', label: '数据', icon: Database },
]

export function App() {
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const leftOpen = useStore((s) => s.leftOpen)
  const inspectorOpen = useStore((s) => s.inspectorOpen)
  const selection = useStore((s) => s.selection)
  const conclusions = useStore((s) => s.conclusions)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const conflicts = conclusions.filter((c) => c.verdict === 'conflict').length
  const open = conclusions.filter((c) => c.verdict === 'open').length

  return (
    <div className="app" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="19" height="19">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 6.5 V12 L15.8 14.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="12" cy="12" r="1.3" fill="currentColor" />
            </svg>
          </span>
          <div className="brand-text">
            <h1>时序取证</h1>
            <span className="muted tiny">多进程日志 · 因果对齐 · 事故复盘</span>
          </div>
        </div>

        <nav className="view-tabs" role="tablist" aria-label="视图">
          {VIEWS.map((v) => {
            const Icon = v.icon
            const active = view === v.id
            return (
              <button
                key={v.id}
                role="tab"
                aria-selected={active}
                className={`view-tab ${active ? 'on' : ''}`}
                onClick={() => setView(v.id)}
              >
                <Icon size={14} strokeWidth={1.8} aria-hidden />
                {v.label}
                {v.id === 'review' && conflicts + open > 0 && (
                  <span className="tab-count">{conflicts + open}</span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="spacer" />

        <div className="topbar-status">
          <span className="status-pill good">{conclusions.filter((c) => c.verdict === 'hold').length} 成立</span>
          <span className="status-pill warn">{open} 未定</span>
          <span className="status-pill bad">{conflicts} 冲突</span>
        </div>

        <button
          className="icon-btn"
          onClick={() => useStore.getState().setLeftOpen(!leftOpen)}
          aria-label={leftOpen ? '收起证据栏' : '展开证据栏'}
          aria-pressed={leftOpen}
          title={leftOpen ? '收起证据栏' : '展开证据栏'}
        >
          <PanelRightClose size={16} strokeWidth={1.8} style={{ transform: 'scaleX(-1)' }} />
        </button>
        <button
          className="icon-btn"
          onClick={() => useStore.getState().setInspectorOpen(!inspectorOpen)}
          aria-label={inspectorOpen ? '收起检查器' : '展开检查器'}
          aria-pressed={inspectorOpen}
          title={inspectorOpen ? '收起检查器' : '展开检查器'}
        >
          {inspectorOpen ? <PanelRightClose size={16} strokeWidth={1.8} /> : <PanelRightOpen size={16} strokeWidth={1.8} />}
        </button>
        <button
          className="icon-btn"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
        >
          {theme === 'dark' ? <Sun size={16} strokeWidth={1.8} /> : <Moon size={16} strokeWidth={1.8} />}
        </button>
      </header>

      <div className={`workbench ${leftOpen ? '' : 'no-rail'} ${inspectorOpen ? '' : 'no-inspector'}`}>
        {leftOpen && <EvidenceRail />}
        <main className="main-view" role="tabpanel">
          <IncidentBanner />
          {view === 'timeline' && <Timeline />}
          {view === 'clock' && <ClockView />}
          {view === 'review' && <ReviewView />}
          {view === 'data' && <DataView />}
        </main>
        {inspectorOpen && (
          <aside className="side inspector-side">
            <Inspector />
          </aside>
        )}
        {selection.length > 0 && !inspectorOpen && (
          <button className="selection-fab" onClick={() => useStore.getState().setInspectorOpen(true)}>
            已选 {selection.length} 个事件 · 打开检查器
          </button>
        )}
      </div>

      <ToastRegion />
    </div>
  )
}

function EvidenceRail() {
  const scenario = useStore((s) => s.scenario)
  const loaded = useStore((s) => s.loadedBatchIds)
  const loadBatch = useStore((s) => s.loadBatch)
  const loadAll = useStore((s) => s.loadAll)
  const analysis = useStore((s) => s.analysis)
  const snapshots = useStore((s) => s.snapshots)
  const setView = useStore((s) => s.setView)

  const total = scenario.batches.length
  const lastChange = snapshots.length > 1 ? snapshots[snapshots.length - 1] : null
  // Derived once: calling .find() inline twice could crash if the list and the
  // loaded set ever disagree (e.g. a batch id removed from the scenario).
  const nextBatch = scenario.batches.find((b) => !loaded.includes(b.id))

  return (
    <aside className="side evidence-rail">
      <div className="rail-section">
        <h2 className="rail-title">证据进度</h2>
        <div className="progress">
          {scenario.batches.map((b) => {
            const on = loaded.includes(b.id)
            return (
              <button
                key={b.id}
                className={`progress-seg ${on ? 'on' : ''}`}
                onClick={() => !on && loadBatch(b.id)}
                disabled={on}
                title={on ? `${b.title}（已加载）` : `加载 ${b.title}`}
                aria-label={b.title}
              >
                <span className="progress-fill" />
              </button>
            )
          })}
        </div>
        <p className="muted small rail-note">
          已加载 {loaded.length} / {total} 批 · {analysis.events.length} 条日志 ·{' '}
          {analysis.calibrations.length} 个校准点
        </p>
        {nextBatch && (
          <button className="btn full rail-cta" onClick={() => loadBatch(nextBatch.id)}>
            加载下一批：{nextBatch.title}
            <ArrowRight size={13} strokeWidth={2} aria-hidden />
          </button>
        )}
        {nextBatch && (
          <button className="btn ghost tiny full" onClick={loadAll}>
            一次加载全部（{total - loaded.length} 批）
          </button>
        )}
      </div>

      <div className="rail-section">
        <h2 className="rail-title">
          进程
        </h2>
        <ul className="rail-processes">
          {scenario.processes.map((p) => {
            const model = analysis.clocks.get(p.id)
            const n = analysis.eventsByProcess.get(p.id)?.length ?? 0
            const jumps = analysis.jumps.filter((j) => j.processId === p.id).length
            return (
              <li key={p.id} className={n === 0 ? 'absent' : ''}>
                <span className="swatch" style={{ background: processColorVar(p.colorSlot) }} />
                <div className="rp-body">
                  <span className="rp-name">{p.name}</span>
                  <span className="rp-meta mono tiny muted">
                    {p.host} · {n} 事件 · {model?.anchorCount ?? 0} 读数
                  </span>
                </div>
                {jumps > 0 && <Chip tone="bad">{jumps} 跳变</Chip>}
              </li>
            )
          })}
        </ul>
        <button className="link small" onClick={() => setView('clock')}>
          查看偏移与读数 →
        </button>
      </div>

      <div className="rail-section rail-latest">
        <h2 className="rail-title">最近的修订</h2>
        {snapshots.length === 0 ? (
          <p className="muted small">加入证据后，这里会提示哪些结论被改写。</p>
        ) : lastChange ? (
          <>
            <p className="muted small">
              快照 v{lastChange.version} · {new Date(lastChange.at).toLocaleTimeString('zh-CN', { hour12: false })}
            </p>
            <DeltaSummary />
            <button className="btn tiny full" onClick={() => setView('review')}>
              查看哪些结论需要修订
            </button>
          </>
        ) : (
          <>
            <p className="muted small">当前 v{snapshots[0].version} · 尚无前序快照可对比</p>
            <button className="btn tiny full" onClick={() => setView('review')}>
              打开复盘台账
            </button>
          </>
        )}
      </div>

      <div className="rail-section rail-ref">
        <h2 className="rail-title">参考时钟</h2>
        <p className="mono small">{scenario.referenceClock}</p>
        <p className="mono tiny muted">基准 {fmtClock(scenario.baseTs)} UTC</p>
        <p className="muted tiny">
          原始时间戳只读保存；所有校准结果都是另算的估计，不会覆盖日志。
        </p>
      </div>
    </aside>
  )
}

/** Counts the latest snapshot against the one before it, in the rail's own words. */
function DeltaSummary() {
  const snapshots = useStore((s) => s.snapshots)
  const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2] : undefined
  const current = snapshots[snapshots.length - 1]
  const changes = useMemo(() => (current ? diffReviews(previous, current) : []), [previous, current])
  if (!current) return null
  if (!previous) return <p className="muted small">尚无前序快照可对比。</p>
  const changed = changes.filter((c) => c.status === 'changed').length
  const added = changes.filter((c) => c.status === 'new').length
  const resolved = changes.filter((c) => c.status === 'resolved').length
  const stable = changes.filter((c) => c.status === 'stable').length
  const top = changes.filter((c) => c.status === 'changed' || c.status === 'new').slice(0, 2)

  return (
    <>
      <p className="delta-inline small">
        <span className="count-pill changed">{changed} 改写</span>
        <span className="count-pill new">{added} 新增</span>
        {resolved > 0 && <span className="count-pill resolved">{resolved} 解决</span>}
        <span className="count-pill stable">{stable} 不变</span>
      </p>
      {top.length > 0 && (
        <ul className="rail-delta-list">
          {top.map((c) => (
            <li key={c.id}>
              <span className={`delta-tag ${c.status}`}>{c.status === 'changed' ? '改写' : '新增'}</span>
              <span className="trunc">{c.title}</span>
            </li>
          ))}
        </ul>
      )}
      {changed + added + resolved === 0 && <p className="muted small">这次没有结论被改写。</p>}
    </>
  )
}

function IncidentBanner() {
  const scenario = useStore((s) => s.scenario)
  return (
    <div className="incident-banner">
      <div className="ib-main">
        <h2>{scenario.title}</h2>
        <p className="muted small">{scenario.subtitle}</p>
      </div>
      <details className="ib-summary">
        <summary>事故经过</summary>
        <p>{scenario.incident}</p>
      </details>
      <span className="ib-clock mono tiny">{scenario.referenceClock}</span>
    </div>
  )
}

function ToastRegion() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <span className="toast-icon" aria-hidden>
            {t.kind === 'ok' ? (
              <svg viewBox="0 0 12 12" width="12" height="12">
                <path d="M2.5 6.4 L4.8 8.7 L9.5 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            ) : t.kind === 'err' ? (
              <AlertTriangle size={12} strokeWidth={2} />
            ) : (
              <AlertTriangle size={12} strokeWidth={2} />
            )}
          </span>
          <div className="toast-body">
            <strong>{t.title}</strong>
            {t.body && <span className="small muted">{t.body}</span>}
          </div>
          <button className="icon-btn tiny" onClick={() => dismiss(t.id)} aria-label="关闭">
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  )
}
