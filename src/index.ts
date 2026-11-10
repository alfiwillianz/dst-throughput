/**
 * dsh-throughput — a live tokens/second meter for dsh-TUI.
 *
 * Two placements, chosen by config:
 *
 * - `footer` (default): one cell in the prompt footer, beside the model / cache
 *   / workspace line, through `ctx.tuiStatus.setField`.
 * - `panel`: one compact line above the prompt, through
 *   `ctx.tuiStatus.registerView`.
 *
 * Both show a single session total — there are no per-agent rows. Data comes
 * from `agent/assistant-stream` frames (live) and the durable `session/event`
 * stream (exact usage), with `agent/status` for lifecycle. Nothing is written
 * to disk and nothing is appended to the session log.
 *
 * @module dsh-throughput
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves the `session/event` and `session/disposed` declarations.
import type {} from '@deepseek-ai/dsh-session'
// Type-only: resolves the `agent/status` declaration.
import type {} from '@deepseek-ai/dsh-agent'
import { ThroughputStore, fieldDetail, fieldText, type ThroughputOptions } from './store.js'
import { createThroughputView } from './view.js'

export const name = 'throughput'

/** Where the meter renders. */
export type Placement = 'footer' | 'panel'

/** Footer slot: end of the left group, or head/tail of the right group. */
export type FieldSlot = 'left-tail' | 'right-head' | 'right-tail'

/** Configurable knobs; every key has a default so a missing config is a no-op. */
export type Config = {
  /** `footer` = one cell in the prompt footer; `panel` = one line above it.
   *  Accepted as a string and normalized in `resolve`; anything else is `footer`. */
  placement?: string
  /** Render tick in ms. */
  tickMs?: number
  /** Completed-response samples retained for μ / p95. */
  historySize?: number
  /** Fallback characters-per-token estimate when the adapter reports no usage. */
  charsPerToken?: number
  /** Footer only: where the cell joins the footer; anything else is `left-tail`. */
  slot?: string
  /** Footer only: cell width cap in terminal cells (host clamps 1…32). */
  maxCells?: number
  /** Footer only: provide the hover detail line. */
  detail?: boolean
  /** Use `tuiStatus.set` when the chosen rich surface is unavailable. */
  statusLineFallback?: boolean
}

export const Config: Schemastery<Config> = z.object({
  placement: z.string().default('footer'),
  tickMs: z.number().default(200),
  historySize: z.number().default(12),
  charsPerToken: z.number().default(4),
  slot: z.string().default('left-tail'),
  maxCells: z.number().default(12),
  detail: z.boolean().default(true),
  statusLineFallback: z.boolean().default(true),
})

/** Structural view of seam XI; the real type lives in the host. */
interface TuiStatusLike {
  set?(key: string, text: string | undefined): unknown
  setField?(key: string, text: string | undefined, options?: {
    slot?: FieldSlot
    tone?: 'dim' | 'accent' | 'success' | 'warning' | 'error'
    maxCells?: number
    detail?: string
  }): unknown
  registerView?(descriptor: {
    key: string
    maxRows?: 1 | 2 | 3
    component: unknown
  }): (() => void) | undefined
}

interface Resolved extends ThroughputOptions {
  placement: Placement
  tickMs: number
  slot: FieldSlot
  maxCells: number
  detail: boolean
  statusLineFallback: boolean
}

const SLOTS: readonly FieldSlot[] = ['left-tail', 'right-head', 'right-tail']

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function resolve(config: Config): Resolved {
  const slot = SLOTS.includes(config.slot as FieldSlot) ? (config.slot as FieldSlot) : 'left-tail'
  return {
    placement: config.placement === 'panel' ? 'panel' : 'footer',
    tickMs: Math.round(clamp(config.tickMs, 200, 100, 2000)),
    historySize: Math.round(clamp(config.historySize, 12, 1, 64)),
    charsPerToken: clamp(config.charsPerToken, 4, 1, 16),
    slot,
    maxCells: Math.round(clamp(config.maxCells, 12, 1, 32)),
    detail: config.detail ?? true,
    statusLineFallback: config.statusLineFallback ?? true,
  }
}

/**
 * Wire the throughput meter.
 * @param ctx - Cordis context.
 * @param config - Validated plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolve(config)

  // `tuiStatus` comes from the host's extension bundle, and bundle rows are
  // applied before every service they provide is necessarily live. A one-shot
  // `ctx.get('tuiStatus', false)` therefore races the host: on a cold boot the
  // row can run first, see nothing, and leave the meter dark for the whole
  // session (a live patch reload hides this, because the service already
  // exists by then). `ctx.inject` defers the wiring until the service is
  // available and re-runs it when the service is replaced.
  ctx.inject(['tuiStatus'], (scoped) => {
    const status = scoped.get('tuiStatus', false) as TuiStatusLike | undefined
    // No TUI host composed: stay silent rather than failing boot.
    if (status === undefined) return
    wire(scoped, status, resolved)
  })
}

/** Bind the data sources to a live status surface and mount the chosen placement. */
function wire(ctx: Context, status: TuiStatusLike, resolved: Resolved): void {
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

  if (resolved.placement === 'panel') mountPanel(ctx, status, store, resolved)
  else mountFooter(ctx, status, store, resolved)
}

/** Footer placement: one keyed text cell, updated only when the text changes. */
function mountFooter(ctx: Context, status: TuiStatusLike, store: ThroughputStore, resolved: Resolved): void {
  let lastText: string | undefined
  let useField = typeof status.setField === 'function'

  const render = (): void => {
    const snapshot = store.getSnapshot()
    const text = fieldText(snapshot)
    if (text === lastText) return
    lastText = text
    const detail = resolved.detail ? fieldDetail(snapshot) ?? 'session throughput' : undefined
    try {
      if (useField) {
        const result = status.setField?.('throughput', text, {
          slot: resolved.slot,
          tone: snapshot.streaming > 0 ? 'accent' : 'dim',
          maxCells: resolved.maxCells,
          ...(detail === undefined ? {} : { detail }),
        })
        // A refusal (undefined) falls back to the scalar line; a clear is
        // already the terminal state.
        if (result !== undefined || text === undefined) return
        useField = false
      }
      if (resolved.statusLineFallback && status.set !== undefined) status.set('throughput', text)
    } catch {
      // A refused or closed surface must never break the session.
    }
  }

  render()
  const timer = setInterval(render, resolved.tickMs)
  ctx.effect(() => () => {
    clearInterval(timer)
    try {
      if (useField) status.setField?.('throughput', undefined)
      else status.set?.('throughput', undefined)
    } catch {
      // Already gone.
    }
  }, 'throughput footer field')
}

/** Panel placement: one rich line above the prompt, with a scalar fallback. */
function mountPanel(ctx: Context, status: TuiStatusLike, store: ThroughputStore, resolved: Resolved): void {
  const component = createThroughputView(store, { tickMs: resolved.tickMs })
  const dispose = status.registerView?.({ key: 'throughput', maxRows: 1, component })
  if (dispose !== undefined) {
    ctx.effect(() => () => dispose(), 'throughput panel')
    return
  }

  if (!resolved.statusLineFallback || status.set === undefined) return
  let lastText: string | undefined
  const render = (): void => {
    const snapshot = store.getSnapshot()
    const text = fieldText(snapshot)
    if (text === lastText) return
    lastText = text
    try {
      status.set?.('throughput', text)
    } catch {
      // Already gone.
    }
  }
  render()
  const timer = setInterval(render, resolved.tickMs)
  ctx.effect(() => () => {
    clearInterval(timer)
    try {
      status.set?.('throughput', undefined)
    } catch {
      // Already gone.
    }
  }, 'throughput status line')
}
