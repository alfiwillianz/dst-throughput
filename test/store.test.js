import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ThroughputStore, formatTokens, mean, p95, safeTps } from '../lib/types/store.js'

const OPTIONS = {
  maxRows: 3,
  tickMs: 200,
  historySize: 12,
  charsPerToken: 4,
  idleHideMs: 3000,
  showSubagents: true,
}

function agent(id, session = {}) {
  return { id, options: { provider: 'p', model: 'm' }, session }
}

test('live frames produce a per-row rate and a history sample', () => {
  const store = new ThroughputStore(OPTIONS)
  const a = agent('a1')
  const t = Date.now()
  store.onStreamFrame(a, { type: 'start', time: t, turn: 1, step: 1 })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
  store.onStreamFrame(a, { type: 'chunk', time: t + 1100, chunk: { type: 'usage', usage: { outputTokens: 100 } } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.rows.length, 1)
  assert.equal(snapshot.rows[0].label, 'main')
  assert.equal(snapshot.rows[0].phase, 'done')
  assert.equal(snapshot.rows[0].tps, 100)
  assert.equal(snapshot.rows[0].tokens, 100)
  assert.equal(snapshot.last, 100)
  assert.equal(snapshot.spark.length, 1)
})

test('without usage the rate falls back to a character estimate', () => {
  const store = new ThroughputStore(OPTIONS)
  const a = agent('a1')
  const t = Date.now()
  store.onStreamFrame(a, { type: 'start', time: t })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(400) } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })

  const row = store.getSnapshot().rows[0]
  assert.equal(row.tokens, 100) // 400 chars / 4
  assert.equal(row.tps, 100)
})

test('durable usage alone still records a sample', () => {
  const store = new ThroughputStore(OPTIONS)
  const session = {}
  const t = Date.now()
  store.onSessionEvent(session, { type: 'step/start', time: t, data: {} })
  store.onSessionEvent(session, {
    type: 'assistant/message',
    time: t + 2000,
    data: { turn: 1, step: 1, usage: { outputTokens: 50 } },
  })
  assert.equal(store.getSnapshot().last, 25)
  assert.equal(store.getSnapshot().spark.length, 1)
})

test('durable usage corrects a frame sample without double counting', () => {
  const store = new ThroughputStore(OPTIONS)
  const session = {}
  const a = agent('a1', session)
  const t = Date.now()
  store.onStreamFrame(a, { type: 'start', time: t, turn: 1, step: 1 })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })
  store.onSessionEvent(session, {
    type: 'assistant/message',
    time: t + 1200,
    data: { turn: 1, step: 1, usage: { outputTokens: 120 } },
  })

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.spark.length, 1)
  assert.equal(snapshot.rows[0].tokens, 120)
})

test('subagents get their own rows and count as active', () => {
  const store = new ThroughputStore(OPTIONS)
  const t = Date.now()
  const main = agent('main-agent')
  const sub = agent('sub-agent-1')
  store.onStreamFrame(main, { type: 'start', time: t })
  store.onStreamFrame(sub, { type: 'start', time: t })
  store.onStreamFrame(sub, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.rows.length, 2)
  assert.equal(snapshot.active, 2)
  assert.equal(snapshot.streaming, 2)
  assert.ok(snapshot.rows.some(row => row.label.startsWith('sub-')))
})

test('showSubagents=false keeps only the main row', () => {
  const store = new ThroughputStore({ ...OPTIONS, showSubagents: false })
  const t = Date.now()
  store.onStreamFrame(agent('main-agent'), { type: 'start', time: t })
  store.onStreamFrame(agent('sub-agent-1'), { type: 'start', time: t })
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.rows.length, 1)
  assert.equal(snapshot.rows[0].label, 'main')
  assert.equal(snapshot.hidden, 1)
})

test('finished rows are pruned after idleHideMs', () => {
  const store = new ThroughputStore({ ...OPTIONS, idleHideMs: 0 })
  const a = agent('a1')
  const t = Date.now() - 5000
  store.onStreamFrame(a, { type: 'start', time: t })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })
  store.refresh(Date.now() + 10)
  assert.equal(store.getSnapshot().idle, true)
})

test('status line summarizes the session', () => {
  const store = new ThroughputStore(OPTIONS)
  assert.equal(store.statusLine(), 'Throughput · idle')
  const a = agent('a1')
  const t = Date.now()
  store.onStreamFrame(a, { type: 'start', time: t })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })
  assert.match(store.statusLine(), /^Throughput · 10 tps · μ 10 · p95 10 · 10 tok$/)
})

test('helpers: safeTps, mean, p95, formatTokens', () => {
  assert.equal(safeTps(0, 1000), 0)
  assert.equal(safeTps(10, 1000), 10)
  assert.equal(safeTps(10, 0), 50) // clamped to the 200ms floor
  assert.equal(mean([]), undefined)
  assert.equal(mean([10, 20]), 15)
  assert.equal(p95([]), undefined)
  assert.equal(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10)
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1700), '1.7k')
  assert.equal(formatTokens(2_500_000), '2.5m')
})
