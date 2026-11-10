# dsh-throughput

A live **tokens/second** meter for [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) — the
dsh-TUI counterpart of [omp-throughput](https://github.com/kajeagentspi/omp-throughput).

It shows one **session total**: the combined rate of the main agent and every running
subagent, with no per-agent rows. Two placements, chosen by config:

- **`footer`** (default) — one cell in the prompt footer, beside the model / cache / workspace
  line, before the `ctx` chip:

  ```
  deepseek-v4-1-flash-1017 · high · cache 99.5% · dst-throughput · 42 tps        ctx 11% (115k/1.0m)
  ```

- **`panel`** — one compact line above the prompt:

  ```
  Throughput · ▆▇██ · 42 tps · μ 77 · p95 80 · 1 streaming · 780 tok
  ```

- **Zero configuration.** Drop it in and it runs; `placement` is the only knob most people
  touch.
- **Zero disk I/O.** All state lives in process memory and is dropped with the plugin fiber;
  nothing is appended to the session log.
- **O(1) per frame.** Rates are folded incrementally; the history ring is bounded.
- **Total only.** Concurrent agents sum into one number — no rows, no per-agent labels.

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
`assistant/message` usage — per-response rates still work, the live rate does not.

To tune it, override the row's config **by id** in the profile's own `cordis.patch.yml` user
layer — do not insert a second same-id row:

```yaml
- override:
    - id: throughput
      config:
        placement: panel
        slot: right-tail
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `placement` | `'footer'` | `footer` = one cell in the prompt footer; `panel` = one line above it. |
| `tickMs` | `200` | Render tick in ms. |
| `historySize` | `12` | Completed responses retained for μ / p95. |
| `charsPerToken` | `4` | Fallback estimate when the adapter reports no usage. |
| `slot` | `'left-tail'` | Footer only: `left-tail` = after `dst-throughput`; `right-head` = before `ctx`; `right-tail` = after `ctx`. |
| `maxCells` | `12` | Footer only: cell width cap in terminal cells (host clamps 1…32). |
| `detail` | `true` | Footer only: provide the hover line (`μ · p95 · responses · tokens`). |
| `statusLineFallback` | `true` | Use `tuiStatus.set` when the chosen rich surface is unavailable. |

In the default compact footer layout the three slots only order the merged chain; `right-tail`
hugs the right edge only in the split layout. The host lets users hide plugin fields entirely
(`/settings → statusBar.pluginFields`), so the cell is a bonus, not a guarantee.

## How it works

dsh-TUI exposes two complementary sources, and the plugin consumes both:

- **`agent/assistant-stream`** — transient per-attempt frames (`start` / `chunk` / `end`).
  Each `chunk` carries a `StreamChunk` (`text-delta`, `reasoning-delta`, `usage`, …). This is
  the realtime half: it gives the first-token timestamp, the live character count, and the
  adapter's `usage` chunk when one arrives.
- **`session/event`** — durable events. `step/start` anchors the step, `assistant/message`
  carries the exact `usage.outputTokens` (which corrects the frame estimate), and
  `tool/call` / `tool/result` track the agent phase.

`agent/status` supplies the participant lifecycle, and `session/disposed` drops state.

The live rate is `tokens / (now − firstToken)` with a 200 ms floor, summed over every agent
that is currently streaming. A completed response is folded into the history ring once, so a
durable `assistant/message` arriving after the frames corrects the token count without adding a
second sample. Since the ring is bounded, p95 is computed exactly over the retained samples
rather than with a streaming quantile sketch.

Rendering:

- Footer mode calls `ctx.tuiStatus.setField('throughput', text, { slot, tone, maxCells, detail })`
  — seam XI's keyed footer cell. Text is `42 tps` while streaming, the last response when idle,
  and cleared when there is no data; the tone is `accent` while streaming and `dim` otherwise.
  The host call is skipped when the text has not changed.
- Panel mode calls `ctx.tuiStatus.registerView({ key, maxRows: 1, component })` — one line,
  built with the host's own React instance and `ui.Box` / `ui.Text` (no bundled React, no JSX).
- If the chosen surface is unavailable, the plugin falls back to the scalar
  `ctx.tuiStatus.set`; with no `tuiStatus` service at all it stays silent.

## Limitations

- **Estimate before usage.** Until the adapter's `usage` chunk lands, tokens are estimated from
  characters (`charsPerToken`), so the live rate is approximate and settles on completion.
- **Footer is text-only.** The host renders `setField` as plain text, so the sparkline and μ /
  p95 live in the hover detail (and in panel mode), not in the cell.
- **Panel is one line.** The host allows up to three rows, but the meter shows the aggregate
  only; per-agent rows were removed on purpose.
- **No history across restarts.** The ring is in memory; a new process starts empty.

## Build from source

The plugin ships as compiled ESM: `lib/` is generated and is **not** committed, so a fresh
clone has to be built once before dsh-TUI can load it.

**Requirements:** Node `^22.19 || >=24` and npm.

```bash
git clone <this repo> dsh-throughput
cd dsh-throughput

# 1. Install dependencies (including TypeScript and the DSH type packages).
npm install --include=dev

# 2. Compile src/ → lib/types/.
npm run build

# 3. Optional: typecheck only / run the tests.
npm run typecheck
npm test
```

`npm install --include=dev` matters when `NODE_ENV=production` is set in your shell, because
npm then omits devDependencies by default and `tsc` will be missing.

The build writes:

```
lib/types/index.js   plugin entry (name / Config / apply)
lib/types/store.js   throughput registry and stats
lib/types/view.js    panel component and formatting
lib/types/*.d.ts     type declarations
```

`npm run build` runs `tsc -p tsconfig.json`; it emits declarations, so keep the source
TypeScript-clean rather than relying on `skipLibCheck` to hide errors in this package.

### Rebuilding after a change

```bash
npm run build
```

If the package was installed into a profile with `dsh plugin add` (a live link), the next
dsh-TUI start loads the rebuilt `lib/`. Restart dsh-TUI — a running session keeps the module
it already imported.

### Installing the build

```bash
dsh plugin --profile dsh-tui add /path/to/dsh-throughput
```

`dsh plugin add` links the package and appends it to `dsh.profile.bundles`; the bundle patch
mounts the `throughput` row on the next start. See [Install](#install) above.

### Plugin contract

The plugin follows the dsh-TUI runtime-plugin contract: `name` / `Config` (type) / `Config`
(schema) / `apply`, no default export, every config key defaulted, cleanup through
`ctx.effect`, and optional seams probed with `ctx.get(..., false)`.

## License

MIT
