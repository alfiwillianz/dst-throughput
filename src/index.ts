/**
 * dsh-throughput — a live tokens/second meter for dsh-TUI.
 *
 * One header line plus one row per active participant (main agent and
 * subagents), rendered above the prompt through seam XI
 * (`ctx.tuiStatus.registerView`, up to three rows). Hosts that do not expose
 * the rich view fall back to the single-line `ctx.tuiStatus.set` seam.
 *
 * Data sources, both optional and probed structurally:
 * - `agent/assistant-stream` transient frames — live deltas and usage;
 * - `session/event` — durable `step/start`, `assistant/message` (exact usage),
 *   `tool/call`, `tool/result`;
 * - `agent/status` — participant lifecycle.
 *
 * Nothing is written to disk and nothing is appended to the session log.
 *
 * @module dsh-throughput
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves the `session/event` and `session/disposed` declarations.
import type {} from '@deepseek-ai/dsh-session'
// Type-only: resolves the `agent/status` declaration.
import type {} from '@deepseek-ai/dsh-agent'
import { ThroughputStore, type ThroughputOptions } from './store.js'
import { createThroughputView } from './view.js'

export const name = 'throughput'

/** Configurable knobs; every key has a default so a missing config is a no-op. */
export type Config = {
  /** Rows the panel may occupy (1 = header only, 3 = header + two rows). */
  maxRows?: number
  /** Live-gauge refresh interval in ms while something is streaming. */
  tickMs?: number
  /** Completed-response samples retained for the sparkline / μ / p95. */
  historySize?: number
  /** Fallback characters-per-token estimate when the adapter reports no usage. */
  charsPerToken?: number
  /** How long a finished row stays visible, in ms. */
  idleHideMs?: number
  /** Show subagent rows (false keeps the main agent only). */
  showSubagents?: boolean
  /** Hide the panel entirely while nothing is streaming. */
  hideWhenIdle?: boolean
  /** Use `tuiStatus.set` when the host has no `registerView`. */
  statusLineFallback?: boolean
}

export const Config: Schemastery<Config> = z.object({
  maxRows: z.number().default(3),
  tickMs: z.number().default(200),
  historySize: z.number().default(12),
  charsPerToken: z.number().default(4),
  idleHideMs: z.number().default(3000),
  showSubagents: z.boolean().default(true),
  hideWhenIdle: z.boolean().default(true),
  statusLineFallback: z.boolean().default(true),
})

/** Structural view of seam XI; the real type lives in the host. */
interface TuiStatusLike {
  set?(key: string, text: string | undefined): unknown
  registerView?(descriptor: {
    key: string
    maxRows?: 1 | 2 | 3
    component: unknown
  }): (() => void) | undefined
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function resolve(config: Config): ThroughputOptions & { hideWhenIdle: boolean; statusLineFallback: boolean } {
  return {
    maxRows: Math.round(clamp(config.maxRows, 3, 1, 3)),
    tickMs: Math.round(clamp(config.tickMs, 200, 100, 2000)),
    historySize: Math.round(clamp(config.historySize, 12, 1, 64)),
    charsPerToken: clamp(config.charsPerToken, 4, 1, 16),
    idleHideMs: Math.round(clamp(config.idleHideMs, 3000, 0, 60_000)),
    showSubagents: config.showSubagents ?? true,
    hideWhenIdle: config.hideWhenIdle ?? true,
    statusLineFallback: config.statusLineFallback ?? true,
  }
}

/**
 * Wire the throughput meter.
 * @param ctx - Cordis context.
 * @param config - Validated plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const status = ctx.get('tuiStatus', false) as TuiStatusLike | undefined
  // No TUI host composed: stay silent rather than failing boot.
  if (status === undefined) return

  const resolved = resolve(config)
  const store = new ThroughputStore(resolved)

  // Live stream frames (dsh 0.1.5+). On an older host the event is simply
  // never published and the durable path below still feeds the meter.
  ctx.on('agent/assistant-stream', (payload) => {
    if (typeof payload !== 'object' || payload === null) return
    const { agent, frame } = payload as { agent?: unknown; frame?: unknown }
    store.onStreamFrame(agent, frame)
  })

  ctx.on('session/event', (session, event) => {
    store.onSessionEvent(session, event)
  })

  ctx.on('agent/status', ({ agent, status: agentStatus }) => {
    store.onAgentStatus(agent, agentStatus)
  })

  ctx.on('session/disposed', (session) => {
    store.onSessionDisposed(session)
  })

  const component = createThroughputView(store, {
    tickMs: resolved.tickMs,
    hideWhenIdle: resolved.hideWhenIdle,
  })

  const disposeView = status.registerView?.({
    key: 'throughput',
    maxRows: resolved.maxRows as 1 | 2 | 3,
    component,
  })

  if (disposeView !== undefined) {
    ctx.effect(() => () => disposeView(), 'throughput status view')
    return
  }

  if (!resolved.statusLineFallback || status.set === undefined) return
  const set = status.set.bind(status)
  const render = (): void => {
    try {
      set('throughput', store.statusLine())
    } catch {
      // A refused/closed status line must not break the session.
    }
  }
  render()
  const timer = setInterval(render, resolved.tickMs)
  ctx.effect(() => () => {
    clearInterval(timer)
    try {
      set('throughput', undefined)
    } catch {
      // Already gone.
    }
  }, 'throughput status line')
}
