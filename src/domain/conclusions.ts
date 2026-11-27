/**
 * Reviewable conclusions. Each conclusion carries the evidence that produced
 * its verdict, so a newly added calibration point can be diffed against the
 * previous review to show exactly which verdicts moved and why.
 */
import { fmt } from './format'
import { relate } from './analysis'
import type { Analysis, Conclusion, EventId, Relation, ScenarioQuestion } from './types'

export function evidenceVersion(analysis: Analysis, questionCount: number): number {
  return analysis.explicitEdges.length * 1000 + analysis.calibrations.length * 7 + questionCount * 13
}

export function buildConclusions(analysis: Analysis, questions: ScenarioQuestion[]): Conclusion[] {
  const out: Conclusion[] = []
  const label = (id: EventId) => {
    const e = analysis.eventById.get(id)
    const p = e ? analysis.processById.get(e.processId) : undefined
    return e ? `${p?.short ?? '?'}:${e.seq}` : '?'
  }

  for (const q of questions) {
    const rel = relate(q.a, q.b, analysis)
    const judged = judge(rel, label(q.a), label(q.b), analysis)
    out.push({
      id: `q-${q.id}`,
      group: 'question',
      title: q.title,
      events: [q.a, q.b],
      ...judged,
      action:
        judged.verdict === 'open' || judged.verdict === 'conflict'
          ? { kind: 'mark-jump', label: '查看时钟证据' }
          : undefined,
    })
  }

  /* clock: every jump, declared or hidden */
  for (const jump of analysis.jumps) {
    const proc = analysis.processById.get(jump.processId)
    const delta =
      jump.deltaMs !== 0
        ? `偏移变化 ${fmt(jump.deltaMs)}`
        : jump.fromRawBackwards
          ? '原始时间倒退'
          : '已声明的跳变点'
    out.push({
      id: `clock-${jump.id}`,
      group: 'clock',
      title: `${proc?.name ?? jump.processId} 时钟跳变`,
      statement: `${jump.afterEventId} 处：${delta}`,
      verdict: 'conflict',
      detail: jump.message,
      events: [jump.beforeEventId, jump.afterEventId].filter((x): x is string => !!x),
      processId: jump.processId,
      action: jump.declared
        ? undefined
        : { kind: 'mark-jump', label: '标注跳变点', processId: jump.processId, eventId: jump.afterEventId },
    })
  }

  /* edges / cycles */
  for (const conflict of analysis.conflicts) {
    if (conflict.kind === 'raw-backwards') continue
    out.push({
      id: `conflict-${conflict.id}`,
      group: 'edge',
      title:
        conflict.kind === 'cycle'
          ? '因果环'
          : conflict.kind === 'edge-vs-clock'
            ? '因果边与校准时间矛盾'
            : '因果边与日志顺序矛盾',
      statement: conflict.message,
      verdict: 'conflict',
      detail:
        conflict.kind === 'cycle'
          ? '环上的边不参与排序。删除其中一条，或为这个环补充说明。'
          : '时钟与因果不一致时，有一条证据是错的。检查该进程的校准读数，或检查这条边指向的事件。',
      events: [conflict.a, conflict.b],
      processId: conflict.processId,
    })
  }

  /* evidence gaps */
  const uncalibrated = analysis.processes.filter((p) => {
    const model = analysis.clocks.get(p.id)
    return !model || !model.calibrated
  })
  if (uncalibrated.length > 0) {
    out.push({
      id: 'evidence-uncalibrated',
      group: 'evidence',
      title: '存在未校准的进程',
      statement: `${uncalibrated.map((p) => p.name).join('、')} 没有时间读数`,
      verdict: 'info',
      detail:
        '这些进程仍按原始时间显示，但任何跨进程的顺序都不能靠时钟得出，只能靠因果边。补充一条读数即可让它们进入时钟比较。',
      events: [],
      action: {
        kind: 'add-calibration',
        label: '补充校准点',
        processId: uncalibrated[0]?.id,
      },
    })
  }

  if (analysis.unplaced.length > 0) {
    out.push({
      id: 'evidence-unplaced',
      group: 'evidence',
      title: '有时间无法确定的事件',
      statement: `${analysis.unplaced.length} 个事件没有可用时间区间`,
      verdict: 'info',
      detail:
        '这些事件所在区段没有读数（通常是刚跳变、还没标定）。它们只进入「未定序」区，不参与任何跨进程排序。',
      events: analysis.unplaced,
    })
  }

  if (analysis.unpairedSends.length > 0) {
    out.push({
      id: 'evidence-unpaired',
      group: 'edge',
      title: '有发送事件没有声明去向',
      statement: `${analysis.unpairedSends.length} 条发送日志缺少因果边`,
      verdict: 'info',
      detail:
        `未声明因果的发送：${analysis.unpairedSends.map(label).join('、')}。` +
        '如果它们确实跨进程，补上因果边即可显著收窄相关事件的顺序。',
      events: analysis.unpairedSends,
    })
  }

  return out
}

function judge(
  rel: Relation,
  A: string,
  B: string,
  _analysis: Analysis,
): Pick<Conclusion, 'statement' | 'verdict' | 'detail'> {
  if (rel.missing) {
    return {
      verdict: 'info',
      statement: '问题涉及的事件尚未进入证据',
      detail:
        '该问题引用的事件不在当前已加载的日志里。它的证据批次还没加载，或事件被移除了；加载后会自动重判。',
    }
  }

  if (rel.conflict) {
    const causalSide =
      rel.causalKind === 'a-before-b' ? `${A} 早于 ${B}` : rel.causalKind === 'b-before-a' ? `${B} 早于 ${A}` : '无有序'
    const clockSide =
      rel.clockKind === 'a-before-b' ? `${A} 早于 ${B}` : rel.clockKind === 'b-before-a' ? `${B} 早于 ${A}` : '区间重叠'
    return {
      verdict: 'conflict',
      statement: `证据冲突：因果说「${causalSide}」，时钟说「${clockSide}」`,
      detail:
        `若因果链完整，应以因果为准，并修正时钟校准。${rel.causalReason ?? ''}；${rel.clockReason ?? ''}`.trim(),
    }
  }

  if (rel.kind === 'a-before-b' || rel.kind === 'b-before-a') {
    const first = rel.kind === 'a-before-b' ? A : B
    const second = rel.kind === 'a-before-b' ? B : A
    const viaText =
      rel.via === 'causal'
        ? `因果边路径（${rel.chain?.join(' → ')}）`
        : rel.via === 'log'
          ? '同一进程的日志顺序'
          : '校准后的时间区间'
    return {
      verdict: 'hold',
      statement: `成立：${first} 早于 ${second}`,
      detail: `依据：${viaText}。${rel.via === 'clock' ? rel.clockReason ?? '' : rel.causalReason ?? ''}`.trim(),
    }
  }

  if (rel.kind === 'concurrent') {
    const lo = rel.overlapLo
    const hi = rel.overlapHi
    return {
      verdict: 'open',
      statement: '无法定序：两个估计区间重叠',
      detail:
        lo !== null && hi !== null
          ? `重叠区间宽 ${fmt(hi - lo)}。证据不足，不硬排先后；补充校准点或因果边可以收窄。`
          : '证据不足，不硬排先后；补充校准点或因果边。',
    }
  }

  return {
    verdict: 'open',
    statement: '无法判断：缺少把两者联系起来的证据',
    detail:
      rel.clockReason ??
      '两个事件分属不同进程，既无因果路径，也没有可比较的时间区间。',
  }
}
