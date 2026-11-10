/**
 * Rich status view for the throughput meter.
 *
 * Registered through `ctx.tuiStatus.registerView({ key, maxRows, component })`
 * (seam XI, "stable candidate"): the host renders it above the prompt, gives it
 * its own React instance and a pointer-only UI kit (`Box` / `Text`), and clips
 * it at three rows. No JSX and no React import: the component is built with the
 * host's `React.createElement`, which is what keeps a plugin from bundling a
 * second React copy.
 *
 * @module dsh-throughput/view
 */

import type { ThroughputRow, ThroughputSnapshot, ThroughputStore } from './store.js'
import { formatTokens } from './store.js'

/** Minimal structural view of the host React instance passed to the component. */
export interface HostReact {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (value: T) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

/** Minimal structural view of the host UI kit passed to the component. */
export interface HostUi {
  readonly Box: unknown
  readonly Text: unknown
}

/** Props the host hands a rich status component. */
export interface StatusViewProps {
  readonly React: HostReact
  readonly ui: HostUi
}

/** Knobs the view needs beyond the store's own options. */
export interface ViewOptions {
  readonly tickMs: number
  readonly hideWhenIdle: boolean
}

const PHASE_ICON: Record<ThroughputRow['phase'], string> = {
  streaming: '⠴',
  tool: '◇',
  waiting: '·',
  done: '✓',
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const GAUGE_CELLS = 9

/** Sparkline of the retained history, scaled to its own maximum. */
export function sparkline(samples: readonly number[]): string {
  if (samples.length === 0) return ''
  const max = Math.max(...samples)
  if (max <= 0) return '▁'.repeat(samples.length)
  return samples
    .map((value) => {
      const index = Math.min(SPARK.length - 1, Math.max(0, Math.round((value / max) * (SPARK.length - 1))))
      return SPARK[index]
    })
    .join('')
}

/** Filled bar relative to the fastest row. */
export function gauge(tps: number, maxTps: number): string {
  const ratio = maxTps > 0 ? Math.max(0, Math.min(1, tps / maxTps)) : 0
  const filled = Math.round(ratio * GAUGE_CELLS)
  return `▕${'█'.repeat(filled)}${'░'.repeat(GAUGE_CELLS - filled)}▏`
}

/** Header line: session aggregates. */
export function headerLine(snapshot: ThroughputSnapshot): string {
  if (snapshot.idle) return 'Throughput · idle'
  const parts: string[] = []
  if (snapshot.spark.length > 0) parts.push(sparkline(snapshot.spark))
  if (snapshot.last !== undefined) parts.push(`${Math.round(snapshot.last)} tps`)
  if (snapshot.mean !== undefined) parts.push(`μ ${Math.round(snapshot.mean)}`)
  if (snapshot.p95 !== undefined) parts.push(`p95 ${Math.round(snapshot.p95)}`)
  parts.push(`${snapshot.active} active`)
  if (snapshot.streaming > 0) parts.push(`${snapshot.streaming} streaming`)
  if (snapshot.totalTps > 0) parts.push(`${Math.round(snapshot.totalTps)} tps total`)
  if (snapshot.totalTokens > 0) parts.push(`${formatTokens(snapshot.totalTokens)} tok`)
  if (snapshot.hidden > 0) parts.push(`+${snapshot.hidden}`)
  return `Throughput · ${parts.join(' · ')}`
}

/** One participant row. */
export function rowLine(row: ThroughputRow, maxTps: number): string {
  const icon = PHASE_ICON[row.phase]
  const model = row.model === undefined ? '' : ` ${truncate(row.model, 24)}`
  const rate = row.phase === 'streaming' ? `${Math.round(row.tps)} tps` : row.phase === 'done' ? `${Math.round(row.tps)} tps` : '—'
  const tokens = row.tokens > 0 ? ` · ${formatTokens(row.tokens)} tok` : ''
  return `${icon} ${row.label}${model} ${gauge(row.phase === 'streaming' ? row.tps : 0, maxTps)} ${rate}${tokens}`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Build the status-view component bound to one store.
 *
 * The component re-renders only when the store notifies (event-driven), plus a
 * `tickMs` interval while something is streaming so the live gauge decays
 * instead of freezing on the last chunk.
 */
export function createThroughputView(store: ThroughputStore, options: ViewOptions) {
  return function ThroughputView(props: StatusViewProps): unknown {
    const { React, ui } = props
    const [snapshot, setSnapshot] = React.useState<ThroughputSnapshot>(store.getSnapshot())

    React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [])

    React.useEffect(() => {
      if (snapshot.streaming === 0) return
      const timer = setInterval(() => store.refresh(), options.tickMs)
      return () => clearInterval(timer)
    }, [snapshot.streaming])

    if (snapshot.idle && options.hideWhenIdle) return null

    const maxTps = snapshot.rows.reduce((max, row) => Math.max(max, row.tps), 0)
    const lines = [headerLine(snapshot), ...snapshot.rows.map(row => rowLine(row, maxTps))]
    return React.createElement(
      ui.Box,
      { flexDirection: 'column' },
      ...lines.map((text, index) => React.createElement(ui.Text, { key: String(index) }, text)),
    )
  }
}
