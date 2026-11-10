/**
 * One-line panel view for the throughput meter.
 *
 * Registered through `ctx.tuiStatus.registerView({ key, maxRows, component })`
 * (seam XI, "stable candidate"): the host renders it above the prompt, gives it
 * its own React instance and a pointer-only UI kit (`Box` / `Text`), and clips
 * it at three rows. This view asks for one row and draws the aggregate only —
 * the footer placement is the default; the panel is opt-in.
 *
 * No JSX and no React import: the component is built with the host's
 * `React.createElement`, which is what keeps a plugin from bundling a second
 * React copy.
 *
 * @module dsh-throughput/view
 */

import type { ThroughputSnapshot, ThroughputStore } from './store.js'
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

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

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

/** Single line: sparkline, rate, μ, p95, streaming count, tokens. */
export function headerLine(snapshot: ThroughputSnapshot): string {
  if (snapshot.idle) return 'Throughput · idle'
  const parts: string[] = []
  if (snapshot.spark.length > 0) parts.push(sparkline(snapshot.spark))
  const rate = snapshot.streaming > 0 ? snapshot.liveTps : snapshot.last
  if (rate !== undefined) parts.push(`${Math.round(rate)} tps`)
  if (snapshot.mean !== undefined) parts.push(`μ ${Math.round(snapshot.mean)}`)
  if (snapshot.p95 !== undefined) parts.push(`p95 ${Math.round(snapshot.p95)}`)
  if (snapshot.streaming > 0) parts.push(`${snapshot.streaming} streaming`)
  if (snapshot.totalTokens > 0) parts.push(`${formatTokens(snapshot.totalTokens)} tok`)
  return `Throughput · ${parts.join(' · ')}`
}

/**
 * Build the status-view component bound to one store.
 *
 * The component re-renders when the store notifies (event-driven), plus a
 * `tickMs` interval while something is streaming so the live rate decays
 * instead of freezing on the last chunk.
 */
export function createThroughputView(store: ThroughputStore, options: { tickMs: number }) {
  return function ThroughputView(props: StatusViewProps): unknown {
    const { React, ui } = props
    const [snapshot, setSnapshot] = React.useState<ThroughputSnapshot>(store.getSnapshot())

    React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [])

    React.useEffect(() => {
      if (snapshot.streaming === 0) return
      const timer = setInterval(() => store.refresh(), options.tickMs)
      return () => clearInterval(timer)
    }, [snapshot.streaming])

    if (snapshot.idle) return null

    return React.createElement(
      ui.Box,
      { flexDirection: 'column' },
      React.createElement(ui.Text, null, headerLine(snapshot)),
    )
  }
}
