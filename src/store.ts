/**
 * In-memory throughput registry for dsh-TUI.
 *
 * Folds the two live sources the host exposes:
 *
 * - `agent/assistant-stream` transient frames (dsh 0.1.5+): `start` / `chunk` /
 *   `end`, where `chunk.chunk` is a `StreamChunk` (`text-delta`,
 *   `reasoning-delta`, `usage`, …). This is the realtime half.
 * - the durable `session/event` stream (`step/start`, `assistant/message`,
 *   `tool/call`, `tool/result`). `assistant/message` carries the exact
 *   `usage.outputTokens`, so it corrects the frame estimate and is the only
 *   source on hosts that no longer publish live chunks.
 *
 * Nothing is persisted: the registry lives in process memory and is dropped
 * with the plugin fiber.
 *
 * @module dsh-throughput/store
 */

/** Phases a participant can be in, mirroring the row icon vocabulary. */
export type ThroughputPhase = 'streaming' | 'tool' | 'waiting' | 'done'

/** One rendered participant row. */
export interface ThroughputRow {
  readonly id: string
  readonly label: string
  readonly model?: string
  readonly phase: ThroughputPhase
  /** Live tokens/second for this row (0 when nothing is streaming). */
  readonly tps: number
  /** Tokens attributed to the current/last response. */
  readonly tokens: number
}

/** Immutable render snapshot handed to the status view. */
export interface ThroughputSnapshot {
  readonly rows: readonly ThroughputRow[]
  /** Rows that did not fit the panel but are still active. */
  readonly hidden: number
  /** TPS of the last completed response. */
  readonly last?: number
  /** Mean over the retained history. */
  readonly mean?: number
  /** p95 over the retained history. */
  readonly p95?: number
  /** Participants that are not finished. */
  readonly active: number
  /** Participants currently receiving model output. */
  readonly streaming: number
  /** Sum of the live per-row TPS. */
  readonly totalTps: number
  /** Sum of the tokens attributed to every participant. */
  readonly totalTokens: number
  /** Recent completed-response TPS samples, oldest first. */
  readonly spark: readonly number[]
  /** True when there is nothing to show. */
  readonly idle: boolean
}

/** Resolved plugin knobs (schema defaults already applied). */
export interface ThroughputOptions {
  readonly maxRows: number
  readonly tickMs: number
  readonly historySize: number
  readonly charsPerToken: number
  readonly idleHideMs: number
  readonly showSubagents: boolean
}

interface Attempt {
  startedAt: number
  firstTokenAt?: number
  lastAt: number
  chars: number
  usageTokens?: number
  turn?: number
  step?: number
  finalized: boolean
}

interface Participant {
  readonly id: string
  label: string
  model?: string
  phase: ThroughputPhase
  attempt?: Attempt
  tokens: number
  tps: number
  doneAt?: number
  /** `${turn}:${step}` of the response already folded into the history ring. */
  sampleKey?: string
}

const EMPTY: ThroughputSnapshot = {
  rows: [],
  hidden: 0,
  active: 0,
  streaming: 0,
  totalTps: 0,
  totalTokens: 0,
  spark: [],
  idle: true,
}

/** Clamp a TPS value into a finite, non-negative number. */
export function safeTps(tokens: number, elapsedMs: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  if (!Number.isFinite(elapsedMs)) return 0
  const seconds = Math.max(elapsedMs / 1000, 0.2)
  return tokens / seconds
}

/** Exact p95 over a small bounded sample (the ring is ≤ historySize). */
export function p95(samples: readonly number[]): number | undefined {
  if (samples.length === 0) return undefined
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))
  return sorted[index]
}

/** Mean over a sample, or undefined when empty. */
export function mean(samples: readonly number[]): number | undefined {
  if (samples.length === 0) return undefined
  let sum = 0
  for (const value of samples) sum += value
  return sum / samples.length
}

/** Read a plain record without trusting the payload. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The live throughput registry.
 *
 * Callers feed host events into the `on*` methods; the status view subscribes
 * through {@link subscribe} and reads {@link getSnapshot}.
 */
export class ThroughputStore {
  private readonly participants = new Map<string, Participant>()
  private readonly ring: number[] = []
  private readonly listeners = new Set<() => void>()
  /** Session object → participant id, learned from `agent/status`/stream frames. */
  private readonly sessionOwners = new WeakMap<object, string>()
  /** Session object → `${turn}:${step}` already folded from durable usage. */
  private readonly durableSamples = new WeakMap<object, Set<string>>()
  /** Session object → step start timestamp (`step/start`). */
  private readonly stepStarts = new WeakMap<object, number>()
  private mainId: string | undefined
  private dirty = true
  private snapshot: ThroughputSnapshot = EMPTY

  constructor(private readonly options: ThroughputOptions) {}

  /** Subscribe to snapshot changes; returns the unsubscribe function. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Current immutable snapshot. */
  readonly getSnapshot = (): ThroughputSnapshot => {
    if (this.dirty) {
      this.snapshot = this.build(Date.now())
      this.dirty = false
    }
    return this.snapshot
  }

  /** Recompute live rates and notify subscribers (called by the view tick). */
  refresh(now = Date.now()): void {
    this.snapshot = this.build(now)
    this.dirty = false
    this.emit()
  }

  /** One `agent/assistant-stream` frame. */
  onStreamFrame(agent: unknown, frame: unknown, at = Date.now()): void {
    const agentRecord = asRecord(agent)
    const agentId = asString(agentRecord?.id)
    if (agentId === undefined) return
    const session = agentRecord?.session
    if (typeof session === 'object' && session !== null) this.sessionOwners.set(session, agentId)

    const record = asRecord(frame)
    if (record === undefined) return
    const type = asString(record.type)
    const time = asNumber(record.time) ?? at
    const participant = this.ensure(agentId, agentRecord)

    if (type === 'start') {
      this.startAttempt(participant, time, record)
      return
    }
    if (type === 'chunk') {
      this.chunk(participant, record, time)
      return
    }
    if (type === 'end') {
      this.finalize(participant, time)
    }
  }

  /** One durable `session/event`. */
  onSessionEvent(session: unknown, event: unknown): void {
    const eventRecord = asRecord(event)
    if (eventRecord === undefined) return
    const type = asString(eventRecord.type)
    const time = asNumber(eventRecord.time) ?? Date.now()
    const data = asRecord(eventRecord.data)

    switch (type) {
      case 'step/start': {
        if (typeof session === 'object' && session !== null) this.stepStarts.set(session, time)
        return
      }
      case 'tool/call': {
        this.phaseForSession(session, 'tool')
        return
      }
      case 'tool/result': {
        this.phaseForSession(session, 'waiting')
        return
      }
      case 'assistant/message': {
        this.durableUsage(session, data, time)
        return
      }
      default:
        return
    }
  }

  /** One `agent/status` transition. */
  onAgentStatus(agent: unknown, status: unknown, at = Date.now()): void {
    const agentRecord = asRecord(agent)
    const agentId = asString(agentRecord?.id)
    if (agentId === undefined) return
    const session = agentRecord?.session
    if (typeof session === 'object' && session !== null) this.sessionOwners.set(session, agentId)
    const participant = this.ensure(agentId, agentRecord)
    if (status === 'running') {
      if (participant.phase === 'done') {
        participant.phase = 'waiting'
        participant.doneAt = undefined
      }
      return
    }
    if (status === 'idle' && participant.phase !== 'done') {
      participant.attempt = undefined
      participant.tps = 0
      // A turn that produced tokens is finished and should age out; one that
      // never streamed (startup idle) must not flash a done row.
      if (participant.tokens > 0) {
        participant.phase = 'done'
        participant.doneAt = at
      } else {
        participant.phase = 'waiting'
      }
      this.markDirty()
    }
  }

  /** Drop everything owned by a disposed session. */
  onSessionDisposed(session: unknown): void {
    if (typeof session !== 'object' || session === null) return
    const agentId = this.sessionOwners.get(session)
    if (agentId === undefined) return
    this.participants.delete(agentId)
    this.markDirty()
  }

  /** Single-line fallback for hosts without `tuiStatus.registerView`. */
  statusLine(): string {
    const snapshot = this.getSnapshot()
    if (snapshot.idle) return 'Throughput · idle'
    const parts: string[] = []
    if (snapshot.last !== undefined) parts.push(`${Math.round(snapshot.last)} tps`)
    if (snapshot.mean !== undefined) parts.push(`μ ${Math.round(snapshot.mean)}`)
    if (snapshot.p95 !== undefined) parts.push(`p95 ${Math.round(snapshot.p95)}`)
    if (snapshot.active > 0) parts.push(`${snapshot.active} active`)
    if (snapshot.totalTokens > 0) parts.push(`${formatTokens(snapshot.totalTokens)} tok`)
    return parts.length === 0 ? 'Throughput · idle' : `Throughput · ${parts.join(' · ')}`
  }

  private ensure(id: string, agent: Record<string, unknown> | undefined): Participant {
    let participant = this.participants.get(id)
    if (participant !== undefined) return participant
    if (this.mainId === undefined) this.mainId = id
    const options = asRecord(agent?.options)
    const provider = asString(options?.provider)
    const model = asString(options?.model)
    participant = {
      id,
      label: id === this.mainId ? 'main' : `sub-${id.slice(-4)}`,
      ...(model === undefined ? {} : { model: provider === undefined ? model : `${provider}/${model}` }),
      phase: 'waiting',
      tokens: 0,
      tps: 0,
    }
    this.participants.set(id, participant)
    this.markDirty()
    return participant
  }

  private startAttempt(participant: Participant, at: number, frame: Record<string, unknown>): void {
    participant.attempt = {
      startedAt: at,
      lastAt: at,
      chars: 0,
      finalized: false,
      ...(asNumber(frame.turn) === undefined ? {} : { turn: asNumber(frame.turn) }),
      ...(asNumber(frame.step) === undefined ? {} : { step: asNumber(frame.step) }),
    }
    participant.phase = 'streaming'
    participant.doneAt = undefined
    this.markDirty()
  }

  private chunk(participant: Participant, frame: Record<string, unknown>, at: number): void {
    const attempt = participant.attempt ?? (participant.attempt = {
      startedAt: at,
      lastAt: at,
      chars: 0,
      finalized: false,
    })
    if (attempt.finalized) {
      // A late chunk after the terminal frame: ignore rather than reopen.
      return
    }
    const chunk = asRecord(frame.chunk)
    if (chunk === undefined) return
    const text = asString(chunk.text)
    if (text !== undefined) {
      attempt.chars += text.length
      attempt.firstTokenAt ??= at
      attempt.lastAt = at
      participant.phase = 'streaming'
      this.markDirty()
      return
    }
    if (chunk.type === 'usage') {
      const usage = asRecord(chunk.usage)
      const output = asNumber(usage?.outputTokens)
      if (output !== undefined) {
        attempt.usageTokens = output
        attempt.lastAt = at
        this.markDirty()
      }
    }
  }

  private finalize(participant: Participant, at: number): void {
    const attempt = participant.attempt
    if (attempt === undefined || attempt.finalized) return
    attempt.finalized = true
    const tokens = attempt.usageTokens ?? Math.round(attempt.chars / this.options.charsPerToken)
    const elapsed = at - (attempt.firstTokenAt ?? attempt.startedAt)
    const tps = safeTps(tokens, elapsed)
    participant.tokens = tokens
    participant.tps = tps
    participant.phase = 'done'
    participant.doneAt = at
    const key = attempt.turn === undefined || attempt.step === undefined
      ? undefined
      : `${attempt.turn}:${attempt.step}`
    if (key !== undefined) participant.sampleKey = key
    if (tokens > 0) this.pushSample(tps)
    this.markDirty()
  }

  private durableUsage(session: unknown, data: Record<string, unknown> | undefined, at: number): void {
    if (data === undefined) return
    const usage = asRecord(data.usage)
    const output = asNumber(usage?.outputTokens)
    if (output === undefined || output <= 0) return
    const turn = asNumber(data.turn)
    const step = asNumber(data.step)
    const key = turn === undefined || step === undefined ? undefined : `${turn}:${step}`

    const agentId = typeof session === 'object' && session !== null ? this.sessionOwners.get(session) : undefined
    const participant = agentId === undefined ? undefined : this.participants.get(agentId)

    if (participant !== undefined) {
      const attempt = participant.attempt
      if (attempt !== undefined && !attempt.finalized) {
        attempt.usageTokens = output
        this.finalize(participant, at)
        return
      }
      // Frames already folded this response: correct the token count without
      // pushing a second history sample.
      if (key !== undefined && participant.sampleKey === key) {
        participant.tokens = output
        this.markDirty()
        return
      }
    }

    if (key !== undefined && typeof session === 'object' && session !== null) {
      const seen = this.durableSamples.get(session) ?? new Set<string>()
      if (seen.has(key)) return
      seen.add(key)
      this.durableSamples.set(session, seen)
    }

    const startedAt = typeof session === 'object' && session !== null ? this.stepStarts.get(session) : undefined
    const tps = startedAt === undefined ? 0 : safeTps(output, at - startedAt)
    if (tps > 0) this.pushSample(tps)
    if (participant !== undefined) {
      participant.tokens = output
      participant.tps = tps
      if (participant.phase !== 'done') {
        participant.phase = 'done'
        participant.doneAt = at
      }
      this.markDirty()
    }
  }

  private phaseForSession(session: unknown, phase: ThroughputPhase): void {
    if (typeof session !== 'object' || session === null) return
    const agentId = this.sessionOwners.get(session)
    if (agentId === undefined) return
    const participant = this.participants.get(agentId)
    if (participant === undefined || participant.phase === 'done') return
    participant.phase = phase
    this.markDirty()
  }

  private pushSample(tps: number): void {
    if (!Number.isFinite(tps) || tps <= 0) return
    this.ring.push(tps)
    while (this.ring.length > this.options.historySize) this.ring.shift()
  }

  private markDirty(): void {
    this.dirty = true
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A broken subscriber must never take the registry down.
      }
    }
  }

  private build(now: number): ThroughputSnapshot {
    for (const [id, participant] of this.participants) {
      if (participant.phase === 'done' && participant.doneAt !== undefined && now - participant.doneAt > this.options.idleHideMs) {
        this.participants.delete(id)
      }
    }

    const rows: ThroughputRow[] = []
    for (const participant of this.participants.values()) {
      const live = participant.phase === 'done' ? participant.tps : this.liveTps(participant, now)
      rows.push({
        id: participant.id,
        label: participant.label,
        ...(participant.model === undefined ? {} : { model: participant.model }),
        phase: participant.phase,
        tps: live,
        tokens: participant.tokens,
      })
    }
    rows.sort((a, b) => b.tps - a.tps || a.label.localeCompare(b.label))

    const visible = this.options.showSubagents
      ? rows.slice(0, Math.max(0, this.options.maxRows - 1))
      : rows.filter(row => row.label === 'main').slice(0, 1)

    const active = rows.filter(row => row.phase !== 'done').length
    const streaming = rows.filter(row => row.phase === 'streaming').length
    const totalTps = rows.reduce((sum, row) => sum + row.tps, 0)
    const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0)
    const spark = [...this.ring]
    const last = spark.length === 0 ? undefined : spark[spark.length - 1]

    const average = mean(spark)
    const tail = p95(spark)
    const snapshot: ThroughputSnapshot = {
      rows: visible,
      hidden: Math.max(0, rows.length - visible.length),
      ...(last === undefined ? {} : { last }),
      ...(average === undefined ? {} : { mean: average }),
      ...(tail === undefined ? {} : { p95: tail }),
      active,
      streaming,
      totalTps,
      totalTokens,
      spark,
      idle: rows.length === 0,
    }
    return snapshot
  }

  private liveTps(participant: Participant, now: number): number {
    const attempt = participant.attempt
    if (attempt === undefined || attempt.finalized) return participant.tps
    const tokens = attempt.usageTokens ?? attempt.chars / this.options.charsPerToken
    if (tokens <= 0) return 0
    const elapsed = now - (attempt.firstTokenAt ?? attempt.startedAt)
    return safeTps(tokens, elapsed)
  }
}

/** `1.7k` / `780` token formatting. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}m`
}
