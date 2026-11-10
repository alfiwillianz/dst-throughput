import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gauge, headerLine, rowLine, sparkline } from '../lib/types/view.js'

const SNAPSHOT = {
  rows: [
    { id: 'a', label: 'main', model: 'p/m', phase: 'streaming', tps: 42, tokens: 780 },
    { id: 'b', label: 'sub-1', phase: 'tool', tps: 0, tokens: 0 },
  ],
  hidden: 0,
  last: 75,
  mean: 77,
  p95: 80,
  active: 2,
  streaming: 1,
  totalTps: 42,
  totalTokens: 780,
  spark: [50, 60, 70, 75],
  idle: false,
}

test('sparkline scales to its own maximum', () => {
  assert.equal(sparkline([]), '')
  assert.equal(sparkline([0, 0]), '▁▁')
  assert.equal(sparkline([1, 8]), '▂█')
})

test('gauge fills relative to the fastest row', () => {
  assert.equal(gauge(0, 42), '▕░░░░░░░░░▏')
  assert.equal(gauge(42, 42), '▕█████████▏')
  assert.equal(gauge(21, 42), '▕█████░░░░▏')
  assert.equal(gauge(1, 0), '▕░░░░░░░░░▏')
})

test('header carries aggregates and hides zero sections', () => {
  const line = headerLine(SNAPSHOT)
  assert.match(line, /^Throughput · ▆▇██ · 75 tps · μ 77 · p95 80 · 2 active · 1 streaming · 42 tps total · 780 tok$/)
  assert.equal(headerLine({ ...SNAPSHOT, idle: true, rows: [] }), 'Throughput · idle')
})

test('row shows icon, label, model, gauge and tokens', () => {
  const line = rowLine(SNAPSHOT.rows[0], 42)
  assert.match(line, /^⠴ main p\/m ▕█████████▏ 42 tps · 780 tok$/)
  const tool = rowLine(SNAPSHOT.rows[1], 42)
  assert.match(tool, /^◇ sub-1 ▕░░░░░░░░░▏ —$/)
})

test('long model names are truncated', () => {
  const row = { id: 'x', label: 'main', model: 'provider/a-very-long-model-name-here', phase: 'done', tps: 1, tokens: 1 }
  assert.match(rowLine(row, 1), /…/)
})
