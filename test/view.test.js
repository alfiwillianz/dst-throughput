import assert from 'node:assert/strict'
import { test } from 'node:test'
import { headerLine, sparkline } from '../lib/types/view.js'

const SNAPSHOT = {
  liveTps: 42,
  last: 75,
  mean: 77,
  p95: 80,
  streaming: 1,
  active: 1,
  totalTokens: 780,
  responses: 4,
  spark: [50, 60, 70, 75],
  idle: false,
}

test('sparkline scales to its own maximum', () => {
  assert.equal(sparkline([]), '')
  assert.equal(sparkline([0, 0]), '▁▁')
  assert.equal(sparkline([1, 8]), '▂█')
})

test('header shows the live rate while streaming', () => {
  assert.equal(
    headerLine(SNAPSHOT),
    'Throughput · ▆▇██ · 42 tps · μ 77 · p95 80 · 1 streaming · 780 tok',
  )
})

test('header falls back to the last completed rate when idle', () => {
  assert.equal(
    headerLine({ ...SNAPSHOT, streaming: 0, active: 0 }),
    'Throughput · ▆▇██ · 75 tps · μ 77 · p95 80 · 780 tok',
  )
})

test('header without history or tokens stays short', () => {
  assert.equal(
    headerLine({ liveTps: 0, streaming: 0, active: 0, totalTokens: 0, responses: 0, spark: [], idle: true }),
    'Throughput · idle',
  )
})
