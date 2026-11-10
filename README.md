# dsh-throughput

A live **tokens/second** meter for [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) — the
dsh-TUI counterpart of [omp-throughput](https://github.com/kajeagentspi/omp-throughput).

It renders a compact panel above the prompt: one header line with the session summary
(sparkline of recent responses, last TPS, mean μ, p95, active/streaming counts, total tokens)
and one row per active participant (the main agent and every running subagent) with a live
gauge, its model, and the tokens attributed to the current response.

```
Throughput · ▆▇██ · 75 tps · μ 77 · p95 80 · 2 active · 1 streaming · 42 tps total · 780 tok
⠴ main p/deepseek-chat ▕█████████▏ 42 tps · 780 tok
◇ sub-1 p/deepseek-chat ▕░░░░░░░░░▏ — 
```

- **Zero configuration.** Drop it in and it runs.
- **Zero disk I/O.** All state lives in process memory and is dropped with the plugin fiber;
  nothing is appended to the session log.
- **O(1) per frame.** Rates are folded incrementally; the history ring is bounded.
- **Subagent aware.** One row per in-flight agent, keyed by the agent that published the
  stream frames.

## Install

From this checkout (local development):

```bash
dsh plugin --profile dsh-tui add /path/to/dst-throughput
```

or from inside dsh-TUI:

```
/plugin install /path/to/dst-throughput
```

Restart dsh-TUI. The bundle patch mounts the `throughput` row automatically; no manual
`cordis.patch.yml` edit is needed.

The profile entry is a live link (`dsh-throughput: link:/path/to/dst-throughput`), so a
`npm run build` picks up changes on the next dsh-TUI start.

### Compatibility

Built and compiled against `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session`
`0.2.2-rc.1`; the declared peer range follows dsh-TUI's own union
(`^0.1.0-rc.6 … 0.2.2-rc.1`). On hosts older than 0.1.5 the live
`agent/assistant-stream` event does not exist, and the meter falls back to durable
`assistant/message` usage — per-response rates still work, the live gauge does not.

To tune it, override the row's config **by id** in the profile's own `cordis.patch.yml` user
layer — do not insert a second same-id row:

```yaml
- override:
    - id: throughput
      config:
        maxRows: 2
        showSubagents: false
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `maxRows` | `3` | Panel height: 1 = header only, 3 = header + two rows. |
| `tickMs` | `200` | Live-gauge refresh interval while streaming. |
| `historySize` | `12` | Completed responses retained for the sparkline / μ / p95. |
| `charsPerToken` | `4` | Fallback estimate when the adapter reports no usage. |
| `idleHideMs` | `3000` | How long a finished row stays visible. |
| `showSubagents` | `true` | Show one row per subagent. |
| `hideWhenIdle` | `true` | Hide the panel entirely while nothing is streaming. |
| `statusLineFallback` | `true` | Use `tuiStatus.set` when the host has no `registerView`. |

## How it works

dsh-TUI exposes two complementary sources, and the plugin consumes both:

- **`agent/assistant-stream`** — transient per-attempt frames (`start` / `chunk` / `end`).
  Each `chunk` carries a `StreamChunk` (`text-delta`, `reasoning-delta`, `usage`, …). This is
  the realtime half: it gives the first-token timestamp, the live character count, and the
  adapter's `usage` chunk when one arrives.
- **`session/event`** — durable events. `step/start` anchors the step, `assistant/message`
  carries the exact `usage.outputTokens` (which corrects the frame estimate), and
  `tool/call` / `tool/result` drive the phase icon.

`agent/status` supplies the participant lifecycle, and `session/disposed` drops state.

The live rate is `tokens / (now − firstToken)` with a 200 ms floor; a completed response is
folded into the history ring once, so a durable `assistant/message` arriving after the frames
corrects the token count without adding a second sample. Since the ring is bounded, p95 is
computed exactly over the retained samples rather than with a streaming quantile sketch.

Rendering goes through seam XI, `ctx.tuiStatus.registerView({ key, maxRows, component })`, the
host's rich status view above the prompt (clipped at three rows). The component is built with
the host's own React instance and `ui.Box` / `ui.Text` — no bundled React, no JSX. On hosts
that predate `registerView`, the plugin falls back to the single-line `ctx.tuiStatus.set`.

## Limitations

- **Three rows.** The host clips rich status views at three rows, so the panel is a header plus
  at most two participant rows; extra active rows collapse into a `+N` counter.
- **Subagent labels** are `sub-<id suffix>`: dsh-TUI does not expose the task name or agent
  type to plugins, so the omp-style `scout` / `reviewer` badges have no source here yet.
- **No click/keyboard interaction.** Rich status views are pointer-only; a click action would
  need a paired `tuiShortcuts` action.
- **Estimate before usage.** Until the adapter's `usage` chunk lands, tokens are estimated from
  characters (`charsPerToken`), so the live gauge is approximate and settles on completion.

## Development

```bash
npm install --include=dev
npm run build      # tsc → lib/types
npm test           # node --test
```

The plugin follows the dsh-TUI runtime-plugin contract: `name` / `Config` (type) / `Config`
(schema) / `apply`, no default export, every config key defaulted, cleanup through
`ctx.effect`, and optional seams probed with `ctx.get(..., false)`.

## License

MIT
