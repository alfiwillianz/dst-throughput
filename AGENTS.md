# AGENTS.md

Project instructions for coding agents working in this repository.

## Commits

Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[(scope)][!]: <subject>

[body]

[footer(s)]
```

- **Types**: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `style`, `chore`, `revert`.
- **Subject**: imperative mood, lowercase after the colon, no trailing period, 72 characters or fewer.
- **Body**: wrapped at 72 columns and separated from the subject by one blank line. Explain *why* the
  change is needed; do not restate the diff.
- **Breaking change**: `!` after the type or scope (`feat(footer)!: drop the per-agent rows`) plus a
  `BREAKING CHANGE:` footer.
- **Scope** is optional. Use the module or surface touched: `store`, `view`, `footer`, `panel`, `build`.
- **One logical change per commit.** A refactor and a behaviour change belong in two commits.

`git log --oneline` should read as the changelog.

## Checks before committing

```bash
npm run typecheck
npm test
```

`npm run build` is only needed when you want to exercise the compiled `lib/` — it is generated and
not committed, so a fresh clone has to build once before dsh-TUI can load the plugin.
