# Bin Test

Dragon CLI demo that consumes [type-a-bin](../../README.md), the
`mockBin` library at the repo root. `src/dragon.ts` wraps a fictional
`dragon` binary; the tests mock it with `mockBin` so they run without a
real `dragon` executable on the `PATH`.

## Prerequisites

- [Node.js](https://nodejs.org) 26 and [pnpm](https://pnpm.io) (enforced
  via `engines`)
- Lint, format, and Markdown tooling live at the repo root — run them
  from there with `pnpm lint` / `pnpm format`

## Quick Start

``` bash
pnpm install
pnpm build
pnpm test
```

## Scripts

These run from `packages/bin-test`; build and test orchestration for the
whole repo lives at the root (`pnpm build`, `pnpm test`).

| Script            | Description                      |
|-------------------|----------------------------------|
| `pnpm build`      | Type-check with `tsc` (`noEmit`) |
| `pnpm test`       | Run the unit tests               |
| `pnpm test:watch` | Watch mode                       |

## Coding Conventions

Enforced by the repo-root toolchain (ts-canon: Biome, oxlint, ast-grep,
pandoc):

- Arrow functions only — no `function` declarations
- Separate exports — no inline `export` keywords
- Single-statement brace stripping for `if`/`for`/`while`
- Double quotes, 2-space indent, 80-char width, trailing commas,
  semicolons
- ESM only (`"type": "module"`)
- Markdown formatted with `pandoc -t gfm`
