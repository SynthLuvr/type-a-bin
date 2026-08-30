# Type-A-Bin

> Mock any executable binary — for testing scripts that shell out.

[![License:
MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Have a script or CLI that executes shell commands (`git`, `gh`,
`docker`, `kubectl`…)? Want to test that code without actually invoking
those commands — no network calls, no side effects, no real
dependencies? **Type-A-Bin** lets you mock any executable binary by
injecting a mock script into your `PATH`.

- **Intercept any command.** The moment your code shells out, the mock
  takes over.
- **Total control over output and exit codes.** Return whatever stdout,
  stderr, and exit status your tests need.
- **Invocation recording.** Scripted mocks record every call — argv,
  cwd, env, even stdin — on `mock.calls` for assertions, and
  `mock.waitForCall()` awaits the call you care about.
- **Conditional mocking.** Mock only the subcommands you care about and
  let everything else fall through to the real binary.
- **Any interpreter.** Bash, Node, Python, Perl — if it has a shebang,
  you can use it.
- **Cross-platform.** The same API works on Linux and Windows.
- **TypeScript-first.** Full type definitions and overloaded signatures.
- **Zero npm runtime dependencies.** Pure Node.js standard library, plus
  a bundled (checked-in, ~14 KB) Windows launcher for `mockBin` — no
  native add-ons, nothing compiled at install time.

Type-A-Bin is a Node.js alternative to the npm packages
[mock-bin](https://github.com/stevemao/mock-bin) and
[mock-a-bin](https://github.com/levibostian/mock-a-bin). It began as a
Deno-to-Node.js migration of `mock-a-bin` and has since grown into a
fully typed, dependency-free library with richer features.

------------------------------------------------------------------------

## Table of Contents

- [Why does this exist?](#why-does-this-exist)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [1. Output shorthand](#1-output-shorthand)
  - [2. Full script](#2-full-script)
  - [3. Script file](#3-script-file)
  - [4. Scripted behaviour](#4-scripted-behaviour)
  - [Conditional mocking](#conditional-mocking)
    - [Pattern-based mocking](#pattern-based-mocking)
    - [Script-based mocking with
      `mock-a-bin-run-original`](#script-based-mocking-with-mock-a-bin-run-original)
  - [Controlling exit codes](#controlling-exit-codes)
  - [Passing environment variables](#passing-environment-variables)
  - [Mocking multiple commands at
    once](#mocking-multiple-commands-at-once)
  - [Mocking with any interpreter](#mocking-with-any-interpreter)
- [Using with a test runner](#using-with-a-test-runner)
- [Subprocess coverage](#subprocess-coverage)
- [API reference](#api-reference)
  - [`mockBin(...)`](#mockbin)
  - [`withoutMocks(env)`](#withoutmocksenv)
  - [`rmScratch(dir)`](#rmscratchdir)
  - [`runCliAsMain(entry)`](#runcliasmainentry)
  - [Types](#types)
- [Packages](#packages)
- [Prerequisites](#prerequisites)
- [Scripts](#scripts)
- [Releasing](#releasing)
- [How it works under the hood](#how-it-works-under-the-hood)
- [Windows support](#windows-support)
- [Comparison with other tools](#comparison-with-other-tools)
- [Contributing](#contributing)
- [License](#license)

------------------------------------------------------------------------

## Why does this exist?

Testing code that shells out is hard. When a function calls
`execSync("gh pr list")`, your test depends on the real GitHub CLI, a
network connection, a logged-in account, and a real repository. That is
slow, fragile, and impossible to reproduce deterministically.

There are a few common workarounds, each with drawbacks:

| Approach | Problem |
|----|----|
| Stub `child_process` | Couples tests to the module boundary; misses edge cases. |
| `nock` / HTTP mocking | Only works for HTTP, not arbitrary binaries. |
| Real binaries in CI | Slow, requires secrets, produces flaky tests. |
| **Type-A-Bin** | Mocks *any* binary at the `PATH` level — transparently. |

Type-A-Bin works by creating a temporary executable with the same name
as the target binary and prepending its directory to `PATH`. When your
code runs `gh`, the shell resolves it to your mock instead of the real
`gh`. Your application code doesn’t change at all — no dependency
injection, no wrappers, no monkey-patching. This is especially powerful
for testing CLIs and scripts that invoke other CLIs.

## How it works

     Your test        process.env.PATH
     ──────────       ────────────────────────────────────────
     mockBin("gh")    /tmp/mock-bin-xK9/  ← prepended  (mock)
       │              /usr/local/bin      ← original   (real gh)
       ▼              /usr/bin
     process calls    ────────────────────────────────────────
     "gh pr list"     The shell finds the mock FIRST, runs it.

Every `mockBin()` call:

1.  Creates a fresh temp directory.
2.  Writes an executable mock script named after your binary into it.
3.  Prepends that directory to `process.env.PATH` so the mock shadows
    the real binary.
4.  Returns a **cleanup function** that restores the original `PATH` and
    deletes the temp directory.

## Installation

``` bash
pnpm add -D type-a-bin
```

Or with npm/yarn:

``` bash
npm install -D type-a-bin
yarn add -D type-a-bin
```

> You can also install pre-built packages straight from GitHub via the
> `dist` branch, which is rebuilt automatically on every merge to
> `main`:
>
> ``` bash
> pnpm add -D github:SynthLuvr/type-a-bin#dist
> ```

## Quick start

``` ts
import { execFileSync } from "node:child_process";
import { mockBin } from "type-a-bin";

// Replace the 'gh' command with a mock that prints custom output
const cleanup = await mockBin("gh", "bash", 'echo "mocked output"');

// Any call to 'gh' now executes the mock script
const output = execFileSync("gh", ["pr", "list"], { encoding: "utf-8" });
console.log(output); // "mocked output\n"

cleanup(); // Restore the original PATH
```

## Usage

`mockBin` offers five calling conventions. Choose the one that fits how
much control you need.

### 1. Output shorthand

When you only need the mock to print static text, skip the interpreter
and pass the output string directly. The mock uses `bash` and `echo`s
the value:

``` ts
const cleanup = await mockBin("git", "Everything is up to date");
// $ git status  →  "Everything is up to date\n"
cleanup();
```

This is the simplest form — perfect for quick stubs where you just need
a predictable string back.

### 2. Full script

For dynamic behaviour — conditional logic, arguments, exit codes — pass
an interpreter (`shebang`) and arbitrary script `code`:

``` ts
const cleanup = await mockBin(
  "gh",
  "bash",
  'echo "pr: $1 $2"',
);

// $ gh pr list  →  "pr: pr list\n"
cleanup();
```

The `shebang` argument accepts either a bare interpreter name or a full
shebang line:

``` ts
// Bare interpreter — wrapped automatically in `#!/usr/bin/env …`
mockBin("git", "bash", 'echo "hi"');

// Full shebang line — used as-is
mockBin("git", "#!/usr/bin/env bash", 'echo "hi"');

// Absolute path
mockBin("git", "#!/bin/bash", 'echo "hi"');
```

The mock receives all arguments the real binary would have received. In
a Bash script, access them via `$1`, `$2`, `"$@"`, etc.:

``` ts
await mockBin(
  "docker",
  "bash",
  `
  echo "Building image: $1"
  echo "Args received: $@"
`,
);
```

### 3. Script file

For larger or more complex mocks, point `mockBin` at a script file on
disk instead of inlining the code:

``` ts
const cleanup = await mockBin("dragon", "node --import tsx", {
  file: "./src/tests/hoard-script.ts",
});
cleanup();
```

**Why a file?** When you inline script code as a string, the mock binary
is written to an *extensionless* temp file. Some tooling relies on file
extensions to decide what to do — most notably `node --import tsx`,
which only transforms `.ts`/`.tsx` files. By passing `{ file }`, the
original file keeps its real extension on disk, so extension-aware
loaders work correctly. Internally, Type-A-Bin writes a tiny `/bin/sh`
wrapper that `exec`s your file through the given interpreter, forwarding
all arguments.

**Picking the interpreter for you.** Skip the interpreter and pass only
`{ file }` — the extension decides:

``` ts
const cleanup = await mockBin("dragon", {
  file: "./src/tests/hoard-script.ts",
});
```

| Extension | Interpreter |
|----|----|
| `.ts` `.tsx` `.mts` `.cts` | `node --import <tsx>` — the tsx loader, resolved to an absolute file URL |
| `.js` `.mjs` `.cjs` | `node` |
| `.sh` | `bash` |
| anything else | throws — pass an interpreter explicitly |

The absolute loader URL matters: a mocked binary often runs with a
working directory outside your package (a temp dir, a fixture store),
where a bare `node --import tsx` cannot resolve `tsx` and the mock would
die on a module-not-found error. The shorthand resolves the loader once,
from the script’s own package first and Type-A-Bin’s installed location
second, and embeds the result. On Windows the trampoline bootstrap
imports the same URL before loading a `.ts` entry. When tsx is not
installed at all, Node’s native type stripping parses erasable
TypeScript instead.

This works with any language and any file extension:

``` ts
// A Python mock
await mockBin("mycli", "python3", {
  file: "./tests/mocks/mycli.py",
});
```

### 4. Scripted behaviour

For the most common testing need — stub a binary’s output, set its exit
code, and assert how it was invoked — skip the script entirely and pass
a behaviour object. The mock prints your lines, exits with your code,
and records every invocation:

``` ts
const mock = await mockBin("gh", {
  stdout: ["#1 Fix login", "#2 Add docs"],
  lineDelayMs: 50, // stream the lines one at a time
  exitCode: 1,
});

// Anywhere in your code under test:
// $ gh pr list  →  "#1 Fix login\n#2 Add docs\n", streamed, exit 1

expect(mock.calls[0]?.args).toEqual(["pr", "list"]);
expect(mock.calls[0]?.cwd).toBe(process.cwd());
expect(mock.calls[0]?.env.GH_TOKEN).toBe("secret");

mock(); // The handle is still the cleanup function
```

Each call is recorded the moment the mock starts — before it sleeps,
streams, or answers — so `mock.calls` is ready to assert even while a
slow mock is still running. Reading stdin blocks until the caller closes
it, so it is opt-in: `record: { stdin: true }` captures the full input
as `call.stdin`, ideal for asserting the payload your code piped into
the binary.

A record lands on disk a beat after the spawn that caused it — the
mocked process writes it itself — so reading `mock.calls` right after an
asynchronous spawn races it. `waitForCall` polls `calls` until the
invocation you care about appears, instead of every test hand-rolling
that loop:

``` ts
const child = spawn("gh", ["pr", "create"], { stdio: "ignore" });

// Resolves with the first matching invocation — even while a slow mock
// is still answering. Rejects after the timeout (default 5000ms),
// listing the invocations recorded so far.
const call = await mock.waitForCall(
  (invocation) => invocation.args[0] === "pr",
);
expect(call.args).toEqual(["pr", "create"]);
```

Omit the predicate to wait for any invocation. The poll is safe against
records caught mid-write: a slot the mock claimed but has not published
yet reads as absent and is picked up on a later pass. And after `mock()`
tears the mock down, the wait consults the frozen snapshot — a match
resolves at once, a miss rejects immediately instead of burning the
timeout on invocations that can no longer arrive.

The behaviour object scripts the whole response:

| Option | Type | Default | Description |
|----|----|----|----|
| `record` | `boolean \| { stdin?: boolean }` | `true` | Record invocations on `mock.calls` |
| `stdout` | `string \| readonly string[]` | — | Line(s) written to stdout, each followed by a newline |
| `stderr` | `string \| readonly string[]` | — | Line(s) written to stderr, after the stdout lines |
| `exitCode` | `number` | `0` | Exit code the mock finishes with |
| `delayMs` | `number` | `0` | Delay before the mock writes anything |
| `lineDelayMs` | `number` | `0` | Gap between stdout lines, so a tailing consumer sees them one at a time |
| `spawnChild` | `boolean \| { lifetimeMs?: number }` | — | Spawn a long-lived descendant, its pid recorded as `call.childPid` |
| `trapSignals` | `boolean \| { lifetimeMs?: number }` | — | Ignore SIGINT/SIGTERM, forcing a stop to escalate to SIGKILL |

The last two script lifecycle scenarios: `spawnChild` lets a test prove
a stop reaps the whole process tree rather than the mock alone;
`trapSignals` lets it prove a stop escalates to SIGKILL. Both keep the
mock (and any descendant) alive for a bounded `lifetimeMs` — 120s by
default — so a mock a test forgets to stop cannot outlive the suite.

Pattern-based mocking composes here too: matching invocations run the
behaviour, everything else falls through to the real binary and is not
recorded (see [Conditional mocking](#conditional-mocking)).

### Conditional mocking

Often you want to mock only *some* invocations of a command and let
others run normally — for example, mock `git status` but use the real
`git log`. Type-A-Bin provides two complementary approaches.

#### Pattern-based mocking

Use a regex `pattern` to match the full command string. Only matching
commands are mocked; everything else passes through to the real binary
automatically:

``` ts
const cleanup = await mockBin(
  {
    binName: "gh",
    pattern: "^gh pr (list|view)", // matches "gh pr list" and "gh pr view"
  },
  "bash",
  'echo "mocked PR command"',
);

// These are mocked:
// $ gh pr list   →  "mocked PR command\n"
// $ gh pr view 123 → "mocked PR command\n"

// Everything else hits the real gh:
// $ gh auth status  →  (real output)
cleanup();
```

The pattern is matched against the full command including the binary
name and all arguments (e.g. `gh pr list`). An empty pattern (`""`)
mocks **every** invocation, just like passing no pattern at all — so you
can toggle the behaviour dynamically.

Pattern-based mocking composes with all five calling conventions,
including the output shorthand:

``` ts
const cleanup = await mockBin(
  { binName: "git", pattern: "^git status" },
  "mocked status",
);
```

> **How patterns work internally:** the generated mock script builds the
> full command string (`"${binName} $*"`) and tests it with `grep -qE`.
> If it matches, the mock code runs; otherwise the real binary is
> invoked directly via `exec`.

#### Script-based mocking with `mock-a-bin-run-original`

For finer-grained, programmatic control, write the logic yourself in the
mock script and call the `mock-a-bin-run-original` helper to delegate
back to the real binary when you want to:

``` ts
const cleanup = await mockBin(
  "git",
  "bash",
  `
  if [ "$1" = "status" ]; then
    echo "Everything is clean!"
  else
    mock-a-bin-run-original "$@"
  fi
`,
);

// $ git status      →  "Everything is clean!\n"   (mocked)
// $ git log --oneline → (real git output)         (passed through)
cleanup();
```

Every `mockBin()` call creates a `mock-a-bin-run-original` executable in
the same temp directory (which is on the `PATH`). This helper restores
the original `PATH`, locates the real binary, and executes it with all
forwarded arguments. It works with **any** interpreter — bash, Node,
Python, etc.:

``` ts
// Conditional mocking from a Node mock
const cleanup = await mockBin("git", "node", `
  const { spawnSync } = require("child_process");
  if (process.argv[2] === "status") {
    console.log("mocked from node");
  } else {
    const result = spawnSync("mock-a-bin-run-original", process.argv.slice(2), {
      stdio: "inherit",
    });
    process.exit(result.status || 0);
  }
`);
cleanup();
```

If the original binary doesn’t exist on the system, the helper prints an
error to stderr and exits with code `127` (the conventional “command not
found” exit status).

### Controlling exit codes

Your mock script controls the exit code exactly like any normal script.
In Bash, use `exit`:

``` ts
const cleanup = await mockBin("git", "bash", "exit 1");

const result = spawnSync("git", { encoding: "utf-8" });
console.log(result.status); // 1

cleanup();
```

This lets you simulate failures, permission errors, timeouts — anything
your application needs to handle.

### Passing environment variables

Environment variables from the calling process are passed through to
both the mock and the original binary. This is useful when you want your
test to inject configuration via `env`:

``` ts
const cleanup = await mockBin("env", "bash", 'mock-a-bin-run-original "$@"');

const result = spawnSync("env", {
  encoding: "utf-8",
  env: {
    ...process.env,
    CUSTOM_TEST_VAR: "my-custom-value",
  },
});

console.log(result.stdout); // includes "CUSTOM_TEST_VAR=my-custom-value"
cleanup();
```

### Mocking multiple commands at once

Call `mockBin` as many times as you need. Each call is independent and
returns its own cleanup function:

``` ts
const cleanupGit = await mockBin("git", "bash", 'echo "mocked git"');
const cleanupGh = await mockBin("gh", "bash", 'echo "mocked gh"');

// $ git status → "mocked git\n"
// $ gh pr list → "mocked gh\n"

cleanupGit();
cleanupGh();
```

### Mocking with any interpreter

Because mocks are real executable scripts with shebangs, you can use any
language available on your system:

``` ts
// Node.js
await mockBin("mytool", "node", 'console.log("from node")');

// Python
await mockBin("mytool", "python3", 'print("from python")');

// Perl
await mockBin("mytool", "perl", 'print "from perl\n";');
```

## Using with a test runner

Type-A-Bin is test-runner agnostic — it only touches `process.env.PATH`.
The recommended pattern is to set up mocks in a `beforeEach`/`beforeAll`
and clean up in `afterEach`/`afterAll` so each test starts with a fresh
`PATH`. Here’s an example using [Vitest](https://vitest.dev):

``` ts
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBin } from "type-a-bin";

describe("my CLI", () => {
  let cleanup: () => void;

  beforeEach(async () => {
    cleanup = await mockBin("git", "bash", 'echo "On branch main"');
  });

  afterEach(() => {
    cleanup();
  });

  it("reads the current branch", () => {
    const output = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("On branch main");
  });
});
```

The same approach works with Jest, Mocha, Node’s built-in test runner,
or any other framework. The key is to always call the cleanup function
to restore the original `PATH` — otherwise mocks leak into subsequent
tests.

## Subprocess coverage

Type-A-Bin’s whole domain is tests that spawn subprocesses — the mocked
binaries themselves, and the real CLIs they shadow. A test runner’s
coverage collects inside its own process, so any code that runs
exclusively in those children reports as 0% no matter how thoroughly the
suite exercises it. This repository hit that exact wall:
`mock-bin-runtime.ts`, `mock-bin-preload.ts`, and
`mock-bin-behaviour-runtime.ts` all execute inside spawned children
(behind the Windows trampoline, the shim preload, or the mocked binary
itself), so its own quality gate had to exclude them.

The optional `type-a-bin/subprocess-coverage` companion closes that gap.
It is off unless the environment opts in, adds no runtime dependency to
the core package (see [Packages](#packages)), and works for any Node
child that inherits the test runner’s environment.

### How it works

1.  When `TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR` names a directory, a
    custom vitest provider points the runner’s `NODE_V8_COVERAGE` at it
    and loads a tiny observer hook through `NODE_OPTIONS`, ordered after
    any loaders already there (see [Observer
    ordering](#observer-ordering)). Children inherit both: Node’s
    built-in profiler then writes one raw profile per child on exit,
    while the observer records the code each child actually executed —
    for `.ts` modules loaded through tsx that is the transpiled output
    plus its inline source map, and under Node’s own type stripping it
    is the source itself, whose transform erases syntax in place and
    preserves offsets.
2.  At the end of the run the provider pairs each raw profile with the
    matching recorded transform, remaps the offsets onto the original
    sources, and merges the result into the run’s coverage map —
    respecting `coverage.include`/`exclude` exactly like in-process
    collection, so child-only files appear in the same report and the
    same thresholds.
3.  Raw profiles are removed after a green run
    (`TYPE_A_BIN_KEEP_RAW_COVERAGE=1` keeps them for debugging); a
    failing run keeps them automatically.

### Observer ordering

`module.registerHooks` chains are LIFO: the last hook to register is the
outermost, and only the outermost load hook sees the code a transforming
loader (tsx and its esbuild) produces. A hook that registers *before*
such a loader still observes the module — it records the pre-transform
source — while `NODE_V8_COVERAGE` offsets address the transpiled output,
silently mis-mapping the file onto wrong lines. Node also processes
`NODE_OPTIONS` `--import` entries before any `--import` on the child’s
own argv.

Two rules follow, both applied for you wherever type-a-bin controls the
spawn:

1.  `subprocessCoverageEnv()` appends the observer after any `--import`
    entries already present in `NODE_OPTIONS`, so a loader wired through
    `NODE_OPTIONS` registers first and the observer wraps it.
2.  TypeScript mocks that run through the tsx loader load the observer
    after the loader explicitly — appended to the POSIX exec line, or
    from the Windows trampoline bootstrap, which imports the observer
    in-process right after tsx when the inherited `NODE_OPTIONS` carries
    no hook entry — there is no startup registration to re-order, so no
    second process is needed. Only a hook already present in
    `NODE_OPTIONS` forces an ordered restart, which drops the inherited
    entry first, because the hook module registers its loader only once
    and the inherited entry would win that registration.

A project’s own launcher no longer needs to hand-roll any of this.
`runCliAsMain`, exported from the dedicated
`type-a-bin/subprocess-coverage/run-cli` subpath, applies both rules
itself:

``` ts
#!/usr/bin/env node
import { runCliAsMain } from "type-a-bin/subprocess-coverage/run-cli";

await runCliAsMain(new URL("../src/cli.ts", import.meta.url));
```

The call captures `process.argv.slice(2)`, repositions argv so the entry
reads its CLI arguments at `process.argv.slice(2)` like a script node
started directly, resolves the tsx loader from the entry’s own package
(node’s native type stripping covers projects without tsx), and loads
the entry exactly the way type-a-bin loads its own mocks: a `.cjs` entry
through `Module._load` with `require.main` set, anything else as ESM.
While `TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR` is set the observer joins
ordered above the loader — the restart above when the inherited
`NODE_OPTIONS` carries the hook, the in-process import when it does not
— and with propagation off no coverage machinery loads at all. The
dedicated subpath is deliberate: it imports nothing beyond node’s own
modules, so the launcher works in trees without vitest or the coverage
toolchain installed.

One known limitation: on the legacy Windows hard-link shims, CommonJS
TypeScript entries load tsx in-process after the observer has
registered, so those records fall back to pre-transform source and
best-effort offsets. The trampoline launcher — the default — is
unaffected.

### Enabling it in a project

Point `coverage.customProviderModule` at the provider and opt in through
the environment (here from the command line; a wrapper script like this
repository’s `scripts/vitest-coverage.mts` works the same):

``` bash
TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR=coverage/.v8-raw \
  pnpm vitest run --coverage
```

``` ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "custom",
      customProviderModule: "type-a-bin/subprocess-coverage/provider",
      include: ["src/**/*.ts"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 },
    },
  },
});
```

Children spawned with an explicit `env` (rather than inheriting the
runner’s) need the same two variables; `subprocessCoverageEnv()` builds
them idempotently:

``` ts
import { subprocessCoverageEnv } from "type-a-bin/subprocess-coverage";

const result = execFileSync("my-cli", ["build"], {
  encoding: "utf-8",
  env: { ...process.env, ...subprocessCoverageEnv() },
});
```

### Environment variables

| Variable | Meaning |
|----|----|
| `TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR` | Directory for raw profiles; unset disables propagation entirely |
| `TYPE_A_BIN_SUBPROCESS_COVERAGE_ROOTS` | Path-delimited directories whose modules are recorded (default: the working directory; `node_modules` is always skipped) |
| `TYPE_A_BIN_KEEP_RAW_COVERAGE` | Set to `1` to keep raw profiles after a green run |

### Caveats

- Only children that exit normally flush a profile: one killed with
  SIGKILL contributes nothing, and on Windows `kill()` is an
  unconditional `TerminateProcess`, so a stopped long-lived child never
  flushes there either.
- Raw profiles are best-effort — a function a child never calls may
  never be compiled, and so cannot be credited. Statement and line
  coverage stay accurate; function and branch percentages read lower
  than an in-process run would show.
- The observer must register before a module loads to record it, so
  preload modules named by `--import` entries that precede it in
  `NODE_OPTIONS` escape observation — the price of ordering it after
  loaders (see [Observer ordering](#observer-ordering)); the modules a
  suite actually tests load long after startup and are unaffected.

## API reference

### `mockBin`

Creates a mock executable and prepends it to `PATH`. Returns an async
**cleanup function** that restores the original `PATH` and removes the
temp directory.

The function is overloaded with five signatures:

#### Script file (interpreter inferred)

``` ts
mockBin(binNameOrConfig, script): Promise<MockBinCleanup>
```

| Parameter | Type | Description |
|----|----|----|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` + `pattern` |
| `script` | `MockBinScriptFile` | `{ file: string }` pointing at a script on disk |

Runs a script file with the interpreter picked from its extension —
TypeScript through the tsx loader (resolved to an absolute URL, so the
mock works from any working directory), `.js` through node, `.sh`
through bash. Throws for extensions with no known interpreter (pass one
explicitly instead) or when the file does not exist.

#### Output shorthand

``` ts
mockBin(binNameOrConfig, output): Promise<MockBinCleanup>
```

| Parameter | Type | Description |
|----|----|----|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` + `pattern` |
| `output` | `string` | The text the mock echoes (via `bash`) |

Mocks the binary so that every invocation prints `output`. The fastest
way to stub a command that just needs to return a string.

#### Full script

``` ts
mockBin(binNameOrConfig, shebang, code): Promise<MockBinCleanup>
```

| Parameter | Type | Description |
|----|----|----|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` + `pattern` |
| `shebang` | `string` | Interpreter (e.g. `"bash"`, `"node"`) |
| `code` | `string` | The script body that runs when the mock is invoked |

Gives full control. The `shebang` accepts a bare interpreter name
(wrapped in `#!/usr/bin/env …` automatically) or a full shebang line.

#### Script file

``` ts
mockBin(binNameOrConfig, shebang, script): Promise<MockBinCleanup>
```

| Parameter | Type | Description |
|----|----|----|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` + `pattern` |
| `shebang` | `string` | Interpreter used to run the file |
| `script` | `MockBinScriptFile` | `{ file: string }` pointing at a script on disk |

Runs a script file through the given interpreter, keeping the file’s
original extension so extension-aware loaders (e.g. `node --import tsx`)
work. Throws if the file does not exist.

#### Scripted behaviour

``` ts
mockBin(binNameOrConfig, behaviour): Promise<MockBinHandle>
```

| Parameter | Type | Description |
|----|----|----|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` + `pattern` |
| `behaviour` | `MockBinBehaviour` | Object scripting output, exit code, timing and lifecycle |

Runs a mock scripted entirely by the `behaviour` object — no
interpreter, no script. Returns a `MockBinHandle`: the ordinary cleanup
function, extended with a `calls` property holding every recorded
invocation in call order. `calls` is read fresh on each access and keeps
serving the last snapshot after cleanup. The handle also carries
`waitForCall(predicate?, timeoutMs?)`, which polls `calls` until an
invocation matching `predicate` appears (any invocation when it is
omitted) and resolves with it — the race-free way to assert on a mock
that a spawned process has not invoked yet. It rejects once `timeoutMs`
(default 5000) passes without a match, listing the recorded invocations;
see [Scripted behaviour](#4-scripted-behaviour).

### `withoutMocks(env)`

Copies an environment without the mock registry, for spawns that must
not be intercepted. Inside a mock, a child spawned with the inherited
environment can re-enter the interception machinery — on Windows a spawn
through a legacy hard-link shim resolves `process.execPath` to the shim
itself. Passing `withoutMocks(process.env)` as the child’s `env` leaves
any preload inert (it finds no registry), and a trampoline-launched mock
handed such an environment forwards the invocation to the real binary
instead of the mock.

``` ts
import { spawn } from "node:child_process";
import { withoutMocks } from "type-a-bin";

const child = spawn(
  process.execPath,
  ["-e", 'setTimeout(() => console.log("helper ran"), 1000)'],
  { env: withoutMocks(process.env) },
);
```

The registry variable’s name is exported as `MOCKS_VAR`, so callers that
need to read or strip the registry never hardcode it.

### `rmScratch(dir)`

Removes a scratch directory tree without ever failing a test: the
deletion is forced and retried (`maxRetries: 40`, `retryDelay: 250`),
because Windows — and busy filesystems generally — can transiently deny
deleting files a just-exited process still holds (shim executables,
SQLite WAL files). A removal that still fails after the retries logs a
warning instead of throwing: leaving a temp directory behind beats
failing a suite that passed.

``` ts
import { rmScratch } from "type-a-bin";

rmScratch(scratchDir); // never throws
```

`mockBin` cleanup uses this helper internally on every platform.

### `runCliAsMain(entry)`

Runs a CLI entry as the process’s main module — the whole launcher shape
a project’s `bin/*.mjs` needs under subprocess coverage (see [Subprocess
coverage](#subprocess-coverage)). `entry` is the CLI’s real
implementation, as a path or file URL; TypeScript entries load through
the tsx loader resolved from the entry’s own package, `.cjs` entries
through `Module._load` with `require.main` set. The returned promise
settles when the entry’s top level finishes, and the process exits with
whatever exit code the entry set.

Import it from the dedicated `run-cli` subpath, which pulls in nothing
beyond node’s own modules, so a launcher works without vitest or the
coverage toolchain installed.

### Types

``` ts
/** A cleanup function that restores the original PATH. */
type MockBinCleanup = () => void;

interface MockBinConfig {
  /** The name of the binary to mock (e.g. "gh", "git"). */
  binName: string;
  /** Optional regex pattern. Only commands matching it are mocked. */
  pattern?: string;
}

interface MockBinScriptFile {
  /**
   * Script executed when the mock runs. The file keeps its real
   * extension, so extension-aware loaders (e.g. `node --import tsx`)
   * parse it — embedding the source inline fails because the mock
   * binary is written to an extensionless temp file.
   */
  file: string;
}

/** A cleanup function, carrying the calls a scripted mock recorded. */
type MockBinHandle = MockBinCleanup & {
  /** Every recorded invocation, in call order. */
  readonly calls: MockBinCall[];
  /**
   * Resolves with the first recorded invocation matching the
   * predicate, polling until it appears; rejects after `timeoutMs`
   * (default 5000) with the invocations recorded so far. Omit the
   * predicate to wait for any invocation.
   */
  readonly waitForCall: (
    predicate?: (call: MockBinCall) => boolean,
    timeoutMs?: number,
  ) => Promise<MockBinCall>;
};

/** One recorded invocation of a scripted mock. */
interface MockBinCall {
  /** Arguments the mock was invoked with, excluding the binary name. */
  args: string[];
  /** Working directory the mock ran in. */
  cwd: string;
  /** Environment the mock ran with. */
  env: Record<string, string>;
  /** Process id of the mock itself. */
  pid: number;
  /** Stdin, when the behaviour recorded it. */
  stdin?: string;
  /** Pid of the descendant, when the behaviour spawned one. */
  childPid?: number;
}

/** How long a spawned descendant or a signal-trapped mock stays alive. */
interface MockBinLifetimeOptions {
  /** Lifetime in milliseconds. Default 120000. */
  lifetimeMs?: number;
}

/** Extra recording knobs for a scripted mock. */
interface MockBinRecordOptions {
  /**
   * Read stdin to end-of-file and record it as `call.stdin`. Off by
   * default: a mock that drains stdin waits for the caller to close it.
   */
  stdin?: boolean;
}

/** Scripts a mock's output, exit code, timing and lifecycle. */
interface MockBinBehaviour {
  /**
   * Record every invocation for `handle.calls`. On by default; pass
   * `false` to skip recording, or `{ stdin: true }` to capture stdin
   * as well.
   */
  record?: boolean | MockBinRecordOptions;
  /** Line(s) written to stdout, each followed by a newline. */
  stdout?: string | readonly string[];
  /** Line(s) written to stderr, after the stdout lines. */
  stderr?: string | readonly string[];
  /** Exit code the mock finishes with. Default 0. */
  exitCode?: number;
  /** Delay before the mock writes anything, in milliseconds. */
  delayMs?: number;
  /**
   * Gap between stdout lines, in milliseconds, so a consumer tailing
   * the stream sees them arrive one at a time instead of one burst.
   */
  lineDelayMs?: number;
  /**
   * Spawn a long-lived descendant and record its pid as `call.childPid`,
   * so a test can prove a stop reaps the whole process tree.
   */
  spawnChild?: boolean | MockBinLifetimeOptions;
  /**
   * Ignore SIGINT and SIGTERM, so stopping the mock has to escalate to
   * SIGKILL.
   */
  trapSignals?: boolean | MockBinLifetimeOptions;
}
```

## Packages

This repository is a [pnpm](https://pnpm.io) workspace. The `type-a-bin`
library lives at the root; additional packages live under `packages/`:

- [`packages/bin-test`](packages/bin-test/) — a dragon CLI demo that
  wraps a fictional `dragon` binary and tests it by mocking the binary
  with `mockBin`. A great reference for how to consume the library in a
  real package.

## Prerequisites

- [Node.js](https://nodejs.org) 26 and [pnpm](https://pnpm.io) (enforced
  via `engines` in `package.json`)
- [pandoc](https://pandoc.org) ≥ 3.10 — only needed for the Markdown
  steps of `pnpm lint` / `pnpm format` (which run through
  [ts-canon](https://github.com/SynthLuvr/ts-canon)), not for using the
  library
- On Windows: [Git for Windows](https://gitforwindows.org/) — its bash
  powers bash-interpreter mocks (node-interpreter mocks need nothing
  beyond Node itself). The `mockBin` launcher itself is bundled in the
  package (`dist/native/win32`), rebuilt and checksum-verified from
  `native/trampoline.c` in CI — no compiler or download is needed at
  install time.

## Scripts

Run from the repository root:

| Script | Description |
|----|----|
| `pnpm build` | Build the library (and workspace packages) to `dist/` |
| `pnpm test` | Build, run unit tests, then run workspace tests |
| `pnpm test:lib` | Run the library suite with subprocess coverage propagation enabled |
| `pnpm lint` | Run all linters via ts-canon (Biome, oxlint, ast-grep, pandoc, peer-deps, audit, jscpd) |
| `pnpm format` | Run all formatters via ts-canon with auto-fix |
| `pnpm test:watch` | Run unit tests in watch mode |

## Releasing

Releases are published to npm by the manually triggered [Release
workflow](https://github.com/SynthLuvr/type-a-bin/actions/workflows/release.yml)
using OIDC trusted publishing — no npm token is stored in the
repository.

One-time setup on npm (required before the workflow can publish): on
npmjs.com, open the package **type-a-bin → Settings → Trusted
publishing** and add a GitHub Actions publisher with repository owner
`SynthLuvr`, repository `type-a-bin`, workflow filename `release.yml`,
an *empty* environment, and the `npm publish` action allowed.

To cut a release, run the workflow from `main` with a semver `bump` or
an exact `version`. It builds, tests, publishes to npm with provenance,
then lands the version bump on `main` via an automatically merged pull
request (the `main` ruleset requires all changes to go through a PR, so
the workflow cannot push to `main` directly), pushes the `vX.Y.Z` tag,
and opens the GitHub release. If the version is already on npm — e.g. a
previous run published but failed later — publish is skipped and only
the remaining bookkeeping runs, so re-running the same version is safe.

If publishing fails, the workflow annotates the run with the fix. Both
known registry rejections are auth or provenance problems, not problems
with the package itself:

- `E404 Not Found - PUT https://registry.npmjs.org/type-a-bin` — npm
  masks a rejected OIDC exchange as a 404: the trusted-publisher entry
  is missing or does not match the exact values above.
- `E422` — provenance requires `package.json` to carry `repository.url`
  matching the GitHub repository
  (`https://github.com/SynthLuvr/type-a-bin`).

## How it works under the hood

When you call `mockBin(...)` (on Linux/macOS — Windows follows the same
shape, see [Windows support](#windows-support)):

1.  **Temp directory.** A fresh directory is created under the OS temp
    folder (e.g. `/tmp/mock-bin-xxxx/`).

2.  **Mock script.** An executable file named after your binary is
    written into the temp dir. Its content depends on the calling
    convention:

    - **Output shorthand** → a `bash` script that echoes the string.
    - **Full script** → the interpreter shebang + your code.
    - **Script file** → a `/bin/sh` wrapper that `exec`s your file
      through the interpreter, forwarding arguments.

3.  **`mock-a-bin-run-original` helper.** A second executable is written
    alongside the mock. It restores the original `PATH`, finds the real
    binary with `command -v`, and `exec`s it with all forwarded
    arguments. This is what powers [script-based conditional
    mocking](#script-based-mocking-with-mock-a-bin-run-original).

4.  **Pattern wrapper** *(only when a `pattern` is given)*. The mock
    script is wrapped so that it builds the full command string, tests
    it against the regex with `grep -qE`, and either runs the mock code
    or `exec`s the real binary directly.

5.  **PATH manipulation.** The temp directory is prepended to
    `process.env.PATH`, so the mock shadows the real binary. The
    original `PATH` is saved.

6.  **Cleanup.** The returned function restores `process.env.PATH` to
    its original value (or deletes it if it was unset) and recursively
    removes the temp directory. Calling cleanup more than once is safe.

Type-A-Bin handles the platform-specific path separator (`:` on Unix,
`;` on Windows) automatically.

## Windows support

The same `mockBin` API works on Windows. Because Windows cannot execute
extensionless `#!` scripts — and Node refuses to spawn `.cmd`/`.bat`
shims without a shell — the implementation swaps the mechanism, not the
contract:

- Each mock binary is a **copy of a tiny trampoline launcher**
  (`type-a-bin-trampoline.exe`, built from
  [`native/trampoline.c`](native/trampoline.c)) named `<bin>.exe`,
  prepended to `PATH` exactly as on Linux.
- The trampoline starts the real Node executable with a small
  **bootstrap script** as Node’s script argument, passing the invoked
  mock executable and the caller’s original arguments after it. A real
  script occupies Node’s first positional slot, so every original
  argument — including leading flags (`gh --version`), embedded quotes,
  line breaks, trailing backslashes, and Unicode — arrives in the mock’s
  `process.argv` exactly as the caller passed it. No shell and no Node
  option parser sits in between.
- The bootstrap dispatches through the same runtime the library uses
  everywhere: node-interpreter mocks (and TypeScript script files,
  loaded through the tsx loader URL) run **in-process** with
  `process.argv` rewritten to `[node, entry, ...args]`; other
  interpreters (`bash`, `python`, …) are resolved from `PATH` and
  spawned with your script and the original arguments.
- The launcher inherits stdin/stdout/stderr, the environment, and the
  working directory, propagates the mock’s exit code, and starts the
  mock inside a Windows Job Object — killing the process you spawned
  reaps the mock and its descendants, while a mock that finishes
  normally releases descendants it deliberately left behind.
- Inside a mock, `process.execPath` is the real Node executable, and
  unrelated Node children spawned during the test no longer carry a
  preload: nothing is injected into `NODE_OPTIONS`.
- The `mock-a-bin-run-original` helper, `pattern` conditionals (both
  flag-first), output shorthand, script files, and cleanup contract all
  behave as on Linux. Cleanup removes the launcher, bootstrap, and
  scripts with the same retry semantics as before.

A legacy mechanism — a hard link of `node.exe` plus a `NODE_OPTIONS`
preload that redirects the shim’s entry — ships as a temporary escape
hatch: set `TYPE_A_BIN_DISABLE_TRAMPOLINE=1` to force it while the
launcher rollout is validated. It cannot support flag-first CLIs,
because Node parses a leading option before the preload runs.

Requirements and behaviour notes:

- **Bash mocks need Git for Windows.** Bash-like interpreters prefer a
  native `bash.exe` (Git Bash) over WSL’s launcher, which cannot run
  Windows-path scripts; well-known Git install locations are probed as a
  fallback.
- **Pass-through needs a real `.exe`.** `mock-a-bin-run-original` and
  pattern fall-through locate and spawn the original binary directly;
  `.cmd`/`.bat`-only binaries (e.g. `npm.cmd`) cannot be spawned by Node
  without a shell. (That limitation is about the *real* binary; the
  mock’s own argv is always forwarded verbatim.)
- **The output shorthand expands `$1`–`$9`, `$*`, and `$@`** from the
  command line (matching bash `echo` for positional parameters); other
  shell substitutions are printed literally.
- **Stacked mocks clean up last-in, first-out.** Like `PATH`, the mock
  registry is snapshot-restored, so call the cleanup functions in
  reverse order of the `mockBin` calls for a full restore.

The mock registry (`TYPE_A_BIN_MOCKS`) and the launcher’s Node
executable (`TYPE_A_BIN_NODE_EXE`) are process environment, not global
state: they only affect processes spawned while mocks are active.
Children spawned from inside a mock escape interception on their own —
[`withoutMocks(process.env)`](#withoutmocksenv) remains for spawns that
must reach the real binary behind a mock.

## Comparison with other tools

| Feature | Type-A-Bin | [mock-bin](https://github.com/stevemao/mock-bin) | [mock-a-bin](https://github.com/levibostian/mock-a-bin) |
|----|:--:|:--:|:--:|
| Mocks any binary via `PATH` | ✅ | ✅ | ✅ |
| Runtime dependencies | 0 npm (bundled Windows launcher) | several | several (Deno) |
| TypeScript types & overloads | ✅ | ❌ | partial |
| Output shorthand | ✅ | ❌ | ❌ |
| Script-file mode (keeps extension) | ✅ | ❌ | ❌ |
| Pattern-based conditional mocking | ✅ | ❌ | ❌ |
| `run-original` pass-through | ✅ | ❌ | ✅ |
| Cleanup function | ✅ | ✅ | ✅ |
| Runtime | Node.js | Node.js | Deno |

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for
the development setup, the coding conventions enforced by the toolchain,
and how to submit changes.

## License

[MIT](LICENSE) © SynthLuvr

## Special Thanks

This project began as a Deno-to-Node.js migration of
[mock-a-bin](https://github.com/levibostian/mock-a-bin) by [Levi
Bostian](https://github.com/levibostian), and it is also a Node.js
alternative to the npm package
[mock-bin](https://github.com/stevemao/mock-bin) by [Steve
Mao](https://github.com/stevemao). Both projects inspired Type-A-Bin.
