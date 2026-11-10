import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, Config, name } from '../lib/types/index.js'

function fakeContext(status) {
  const handlers = new Map()
  const cleanups = []
  const ctx = {
    get: (service, strict) => {
      if (service === 'tuiStatus') return status
      return strict ? undefined : undefined
    },
    on: (event, handler) => {
      handlers.set(event, handler)
    },
    effect: (factory) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  return { ctx, handlers, cleanups }
}

test('exports the runtime-plugin contract', () => {
  assert.equal(name, 'throughput')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})

test('registers a rich status view when the host provides one', () => {
  const registered = []
  const status = {
    registerView: (descriptor) => {
      registered.push(descriptor)
      return () => {}
    },
  }
  const { ctx, handlers, cleanups } = fakeContext(status)
  apply(ctx, {})

  assert.equal(registered.length, 1)
  assert.equal(registered[0].key, 'throughput')
  assert.equal(registered[0].maxRows, 3)
  assert.equal(typeof registered[0].component, 'function')
  assert.ok(handlers.has('agent/assistant-stream'))
  assert.ok(handlers.has('session/event'))
  assert.ok(handlers.has('agent/status'))
  assert.ok(handlers.has('session/disposed'))
  assert.equal(cleanups.length, 1)
})

test('honours maxRows and the subagent switch', () => {
  const registered = []
  const status = { registerView: (descriptor) => { registered.push(descriptor); return () => {} } }
  apply(fakeContext(status).ctx, { maxRows: 1, showSubagents: false })
  assert.equal(registered[0].maxRows, 1)
})

test('falls back to the scalar status line without registerView', () => {
  const calls = []
  const status = {
    set: (key, text) => {
      calls.push([key, text])
      return () => {}
    },
  }
  const { ctx, cleanups } = fakeContext(status)
  apply(ctx, {})
  assert.ok(calls.length >= 1)
  assert.equal(calls[0][0], 'throughput')
  assert.match(calls[0][1], /^Throughput/)
  assert.equal(cleanups.length, 1)
  for (const cleanup of cleanups) cleanup()
})

test('stays a no-op without any TUI status service', () => {
  const { ctx, handlers, cleanups } = fakeContext(undefined)
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(handlers.size, 0)
  assert.equal(cleanups.length, 0)
})

test('fed events never throw through the plugin surface', () => {
  const status = { registerView: () => () => {} }
  const { ctx, handlers } = fakeContext(status)
  apply(ctx, {})
  const agent = { id: 'a1', options: { provider: 'p', model: 'm' }, session: {} }
  const now = Date.now()
  assert.doesNotThrow(() => {
    handlers.get('agent/assistant-stream')({ agent, frame: { type: 'start', time: now, turn: 1, step: 1 } })
    handlers.get('agent/assistant-stream')({ agent, frame: { type: 'chunk', time: now + 100, chunk: { type: 'text-delta', text: 'hello' } } })
    handlers.get('agent/assistant-stream')({ agent, frame: { type: 'end', time: now + 600 } })
    handlers.get('agent/assistant-stream')(null)
    handlers.get('agent/assistant-stream')({ agent: null, frame: null })
    handlers.get('session/event')(agent.session, { type: 'tool/call', data: {} })
    handlers.get('session/event')(agent.session, { type: 'assistant/message', time: now + 700, data: { usage: { outputTokens: 20 } } })
    handlers.get('agent/status')({ agent, status: 'idle' })
    handlers.get('session/disposed')(agent.session)
  })
})
