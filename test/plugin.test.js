import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, Config, name } from '../lib/types/index.js'

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function fakeContext(status) {
  const handlers = new Map()
  const cleanups = []
  const waiting = []
  let current = status
  const ctx = {
    get: () => current,
    on: (event, handler) => {
      handlers.set(event, handler)
    },
    effect: (factory) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    // Mirrors Cordis: run now when the service is already available, otherwise
    // stay parked until it is provided (and re-run on every replacement).
    inject: (_deps, callback) => {
      if (current === undefined) waiting.push(callback)
      else callback(ctx)
    },
  }
  // Publish a status service to callbacks parked in `inject`.
  const provide = (value) => {
    current = value
    for (const callback of waiting.splice(0)) callback(ctx)
  }
  return { ctx, handlers, cleanups, provide }
}

function stream(handlers, agent, frame) {
  handlers.get('agent/assistant-stream')({ agent, frame })
}

function startStreaming(handlers, agent) {
  const t = Date.now()
  stream(handlers, agent, { type: 'start', time: t, turn: 1, step: 1 })
  stream(handlers, agent, { type: 'chunk', time: t + 100, chunk: { type: 'text-delta', text: 'x'.repeat(40) } })
}

test('exports the runtime-plugin contract', () => {
  assert.equal(name, 'throughput')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})

test('footer mode writes a setField cell and clears it on unload', async () => {
  const calls = []
  const status = {
    setField: (key, text, options) => {
      calls.push({ key, text, options })
      return () => {}
    },
  }
  const { ctx, handlers, cleanups } = fakeContext(status)
  apply(ctx, {})

  startStreaming(handlers, { id: 'a1', options: {}, session: {} })
  try {
    await delay(300)
    const last = calls.at(-1)
    assert.equal(last.key, 'throughput')
    assert.match(last.text, /^\d+ tps$/)
    assert.equal(last.options.slot, 'left-tail')
    assert.equal(last.options.tone, 'accent')
    assert.equal(last.options.maxCells, 12)
    assert.equal(last.options.detail, 'session throughput')
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
  assert.equal(calls.at(-1).text, undefined)
})

test('footer placement is the default and honours slot/maxCells', async () => {
  const calls = []
  const status = {
    setField: (key, text, options) => {
      calls.push({ key, text, options })
      return () => {}
    },
  }
  const { ctx, handlers, cleanups } = fakeContext(status)
  apply(ctx, { slot: 'right-tail', maxCells: 8 })
  startStreaming(handlers, { id: 'a1', options: {}, session: {} })
  try {
    await delay(300)
    assert.equal(calls.at(-1).options.slot, 'right-tail')
    assert.equal(calls.at(-1).options.maxCells, 8)
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
})

test('panel mode registers a one-row view', () => {
  const registered = []
  const status = {
    registerView: (descriptor) => {
      registered.push(descriptor)
      return () => {}
    },
  }
  const { ctx } = fakeContext(status)
  apply(ctx, { placement: 'panel' })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].key, 'throughput')
  assert.equal(registered[0].maxRows, 1)
  assert.equal(typeof registered[0].component, 'function')
})

test('falls back to the scalar line when setField is absent', async () => {
  const calls = []
  const status = {
    set: (key, text) => {
      calls.push([key, text])
    },
  }
  const { ctx, handlers, cleanups } = fakeContext(status)
  apply(ctx, {})
  startStreaming(handlers, { id: 'a1', options: {}, session: {} })
  try {
    await delay(300)
    assert.ok(calls.some(([key, text]) => key === 'throughput' && /\d+ tps/.test(text)))
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
})

test('panel mode falls back to the scalar line without registerView', async () => {
  const calls = []
  const status = {
    set: (key, text) => {
      calls.push([key, text])
    },
  }
  const { ctx, handlers, cleanups } = fakeContext(status)
  apply(ctx, { placement: 'panel' })
  startStreaming(handlers, { id: 'a1', options: {}, session: {} })
  try {
    await delay(300)
    assert.ok(calls.some(([key, text]) => key === 'throughput' && /\d+ tps/.test(text)))
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
})

test('stays a no-op without any TUI status service', () => {
  const { ctx, handlers, cleanups } = fakeContext(undefined)
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(handlers.size, 0)
  assert.equal(cleanups.length, 0)
})

test('wires the meter when tuiStatus appears after apply', async () => {
  // A cold boot composes this row before the host's extension bundle registers
  // `tuiStatus`; a one-shot probe would leave the footer dark for the session.
  const calls = []
  const { ctx, handlers, cleanups, provide } = fakeContext(undefined)
  apply(ctx, {})
  assert.equal(handlers.size, 0)

  provide({
    setField: (key, text, options) => {
      calls.push({ key, text, options })
      return () => {}
    },
  })
  assert.equal(typeof handlers.get('agent/assistant-stream'), 'function')

  startStreaming(handlers, { id: 'a1', options: {}, session: {} })
  try {
    await delay(300)
    assert.match(calls.at(-1).text, /^\d+ tps$/)
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
  assert.equal(calls.at(-1).text, undefined)
})

test('panel mode registers once the late tuiStatus arrives', () => {
  const registered = []
  const { ctx, provide } = fakeContext(undefined)
  apply(ctx, { placement: 'panel' })
  assert.equal(registered.length, 0)

  provide({
    registerView: (descriptor) => {
      registered.push(descriptor)
      return () => {}
    },
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].key, 'throughput')
})

test('fed events never throw through the plugin surface', () => {
  const status = { setField: () => () => {} }
  const { ctx, handlers, cleanups } = fakeContext(status)
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
  for (const cleanup of cleanups) cleanup()
})
