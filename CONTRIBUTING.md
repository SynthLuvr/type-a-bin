# Contributing to Type-A-Bin

Thanks for your interest in contributing! This guide covers the
development setup and the conventions enforced by the toolchain.

## Development Setup

``` bash
git clone https://github.com/SynthLuvr/type-a-bin.git
cd type-a-bin
pnpm install
```

### Prerequisites

- [Node.js](https://nodejs.org) 26 and [pnpm](https://pnpm.io) (enforced
  via `engines`)
- [pandoc](https://pandoc.org) ≥ 3.10 — required by the Markdown steps
  of `pnpm lint` / `pnpm format` (run through
  [ts-canon](https://github.com/SynthLuvr/ts-canon)); verify with
  `pnpm exec ts-canon doctor`
- On Windows: [Git for Windows](https://gitforwindows.org/) provides the
  `bash` used by bash-interpreter tests

## Workflow

Before opening a pull request, make sure all of the following pass with
zero errors:

``` bash
pnpm build
pnpm lint
pnpm test
```

These run automatically in CI on every pull request (Linux and Windows),
so it’s best to run them locally first.

## Coding Conventions

The toolchain will fail the build if these are violated, so it’s easiest
to run the formatters and let them fix things for you:

``` bash
pnpm format
```

This repo enforces a strict, opinionated style:

- **Arrow functions only** — no `function` declarations (the only
  exception is TypeScript overload sets, which require them).
- **Separate exports** — write `export` as its own statement, never
  inline (e.g. `export const foo`).
- **Single-statement brace stripping** — `if`/`for`/`while` blocks with
  one body statement should not have braces.
- **Double quotes**, 2-space indentation, 80-character line width,
  trailing commas, semicolons, always-parenthesized arrow functions.
- **ESM only** (`"type": "module"`).
- **Markdown** is formatted with `pandoc -t gfm`, making pandoc the
  single source of truth — run `pnpm format` after editing any `*.md`
  file.

Lint and format run through
[ts-canon](https://github.com/SynthLuvr/ts-canon), the shared org
toolchain (one devDependency bundling biome, oxlint, the ast-grep rules,
and the pandoc/peer-deps/audit helpers); `pnpm exec ts-canon doctor`
checks the environment.

## Project Structure

- The `type-a-bin` library lives at the repository root (`src/`).
- Additional packages live under `packages/` (e.g. `packages/bin-test`,
  a demo that consumes `type-a-bin`).
- Tests live next to the source they cover (`*.test.ts`).

## Submitting Changes

1.  Open a pull request against `main`.
2.  Ensure CI (build, lint, test) is green.
3.  Describe the motivation for the change and link any related issues.

By contributing, you agree that your contributions will be licensed
under the [MIT License](LICENSE).
