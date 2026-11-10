import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ThroughputStore,
  fieldDetail,
  fieldText,
  formatTokens,
  mean,
  p95,
  safeTps,
} from '../lib/types/store.js'

const OPTIONS = { historySize: 12, charsPerToken: 4 }

function agent(id, session = {}) {
  return { id, options: { provider: 'p', model: 'm' }, session }
}

test('live frames produce a completed sample', () => {
  const store = new ThroughputStore(OPTIONS)
  const a = agent('a1')
  const t = Date.now() - 5000
  store.onStreamFrame(a, { type: 'start', time: t, turn: 1, step: 1 })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
  store.onStreamFrame(a, { type: 'chunk', time: t + 1100, chunk: { type: 'usage', usage: { outputTokens: 100 } } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.last, 100)
  assert.equal(snapshot.responses, 1)
  assert.equal(snapshot.totalTokens, 100)
  assert.equal(snapshot.streaming, 0)
  assert.equal(snapshot.idle, false)
  assert.equal(fieldText(snapshot), '100 tps')
})

test('without usage the rate falls back to a character estimate', () => {
  const store = new ThroughputStore(OPTIONS)
  const a = agent('a1')
  const t = Date.now() - 5000
  store.onStreamFrame(a, { type: 'start', time: t })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(400) } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.last, 100) // 400 chars / 4 tokens, 1s
  assert.equal(snapshot.totalTokens, 100)
})

test('durable usage alone still records a sample and tokens', () => {
  const store = new ThroughputStore(OPTIONS)
  const session = {}
  const t = Date.now() - 5000
  store.onSessionEvent(session, { type: 'step/start', time: t, data: {} })
  store.onSessionEvent(session, {
    type: 'assistant/message',
    time: t + 2000,
    data: { turn: 1, step: 1, usage: { outputTokens: 50 } },
  })

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.last, 25)
  assert.equal(snapshot.responses, 1)
  assert.equal(snapshot.totalTokens, 50)
})

test('durable usage corrects a frame sample without double counting', () => {
  const store = new ThroughputStore(OPTIONS)
  const session = {}
  const a = agent('a1', session)
  const t = Date.now() - 5000
  store.onStreamFrame(a, { type: 'start', time: t, turn: 1, step: 1 })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })
  store.onSessionEvent(session, {
    type: 'assistant/message',
    time: t + 1200,
    data: { turn: 1, step: 1, usage: { outputTokens: 120 } },
  })

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.responses, 1)
  assert.equal(snapshot.totalTokens, 120)
})

test('concurrent agents sum into one total', () => {
  const store = new ThroughputStore(OPTIONS)
  const t = Date.now() - 5000
  const main = agent('main-agent')
  const sub = agent('sub-agent-1')
  store.onStreamFrame(main, { type: 'start', time: t })
  store.onStreamFrame(main, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
  store.onStreamFrame(main, { type: 'chunk', time: t + 100, chunk: { type: 'usage', usage: { outputTokens: 100 } } })
  store.onStreamFrame(sub, { type: 'start', time: t })
  store.onStreamFrame(sub, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })

  store.refresh(t + 1100)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.streaming, 2)
  assert.equal(snapshot.liveTps, 110) // 100 + 10
  assert.equal(fieldText(snapshot), '110 tps')
})

test('an idle store has no field text', () => {
  const store = new ThroughputStore(OPTIONS)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.idle, true)
  assert.equal(fieldText(snapshot), undefined)
  assert.equal(fieldDetail(snapshot), undefined)
})

test('field detail carries the history summary', () => {
  const store = new ThroughputStore(OPTIONS)
  const a = agent('a1')
  const t = Date.now() - 5000
  store.onStreamFrame(a, { type: 'start', time: t, turn: 1, step: 1 })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
  store.onStreamFrame(a, { type: 'chunk', time: t + 100, chunk: { type: 'usage', usage: { outputTokens: 100 } } })
  store.onStreamFrame(a, { type: 'end', time: t + 1100 })

  assert.equal(fieldDetail(store.getSnapshot()), 'μ 100 · p95 100 · 1 responses · 100 tok')
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
