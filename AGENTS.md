# AGENTS.md

Instructions for AI coding agents working in this repository.

## Quick Start

``` bash
pnpm install
pnpm build    # type-check
pnpm test     # run tests
pnpm lint     # lint all files
```

## Required Workflow

Always run these before considering work complete:

``` bash
pnpm build && pnpm lint && pnpm test
```

All three must pass with zero errors.

Run tooling through `pnpm <script>`, never by invoking a binary in
`node_modules/.bin` directly — the scripts rely on pnpm putting that
directory on `PATH` and on `scriptShell: bash` from
`pnpm-workspace.yaml`. When adding a script, call the binary by bare
name (`biome check .`); do not wrap it in `pnpm` or `pnpm exec`, which
re-resolves it through a Windows `.CMD` shim that AppLocker-managed
hosts block. On Windows, drive the toolchain from Git Bash.

## Coding Conventions (Enforced)

These are **not** preferences — the toolchain will fail if you violate
them:

### No function declarations

Use `const` + arrow function instead.

``` ts
// ❌ Wrong
function foo() {}

// ✅ Right
const foo = (): void => {};
```

**Exception: function overloads.** TypeScript overloads *require*
`function` declarations — each signature reuses the same name, which is
impossible with `const`. Overload sets are permitted, and the
`no-function-declaration` rule skips any `function_declaration` that
immediately follows an overload signature:

``` ts
// ✅ Allowed — overloads must use function declarations
function toLabel(value: string): string;
function toLabel(value: number): string;
function toLabel(value: string | number): string {
  return `label: ${value}`;
}
```

### No inline exports

Write `export` as a separate statement.

``` ts
// ❌ Wrong
export const foo = 1;

// ✅ Right
const foo = 1;
export { foo };
```

### Single-statement braces are stripped

`if`/`for`/`while` with a single body statement should not have braces.

``` ts
// ❌ Wrong
if (done)
  return;
}

// ✅ Right
if (done)
  return;
```

### Formatting

- Double quotes
- 2-space indentation
- 80-character line width
- Trailing commas
- Semicolons
- Arrow function parentheses always

## Formatting

If the linter complains about formatting, run:

``` bash
pnpm format
```

This runs four steps in order: 1. `convert-to-arrow` — rewrites
`function` declarations to arrow consts 2. `strip-braces` — removes
unnecessary braces from single-statement blocks 3. `biome format` —
formats all files 4. `biome check` — applies lint auto-fixes

## Project Structure

- Source code lives in `src/`
- Tests live in `src/tests/` (filenames end in `.test.ts`)
- `pnpm build` emits compiled output to `dist/` — use `tsx` for dev
  execution
- Additional packages live under `packages/` (e.g. `packages/bin-test`,
  a dragon CLI demo consuming `type-a-bin`)
- ESM only (`"type": "module"`)
