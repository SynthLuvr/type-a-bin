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
- **Conditional mocking.** Mock only the subcommands you care about and
  let everything else fall through to the real binary.
- **Any interpreter.** Bash, Node, Python, Perl — if it has a shebang,
  you can use it.
- **TypeScript-first.** Full type definitions and overloaded signatures.
- **Zero dependencies at runtime.** Pure Node.js standard library.

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
- [API reference](#api-reference)
  - [`mockBin(...)`](#mockbin)
  - [Types](#types)
- [Packages](#packages)
- [Prerequisites](#prerequisites)
- [Scripts](#scripts)
- [How it works under the hood](#how-it-works-under-the-hood)
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

| Approach              | Problem                                                  |
|-----------------------|----------------------------------------------------------|
| Stub `child_process`  | Couples tests to the module boundary; misses edge cases. |
| `nock` / HTTP mocking | Only works for HTTP, not arbitrary binaries.             |
| Real binaries in CI   | Slow, requires secrets, produces flaky tests.            |
| **Type-A-Bin**        | Mocks *any* binary at the `PATH` level — transparently.  |

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
pnpm add -D github:SynthLuvr/type-a-bin#dist
```

> The `dist` branch holds the compiled package and is updated
> automatically on every merge to `main`. This means you always install
> ready-to-use JavaScript — no build step on your end.

With npm or yarn:

``` bash
npm install -D SynthLuvr/type-a-bin#dist
yarn add -D SynthLuvr/type-a-bin#dist
```

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

`mockBin` offers three calling conventions. Choose the one that fits how
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

This works with any language and any file extension:

``` ts
// A Python mock
await mockBin("mycli", "python3", {
  file: "./tests/mocks/mycli.py",
});
```

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

Pattern-based mocking composes with all three calling conventions,
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

## API reference

### `mockBin`

Creates a mock executable and prepends it to `PATH`. Returns an async
**cleanup function** that restores the original `PATH` and removes the
temp directory.

The function is overloaded with three signatures:

#### Output shorthand

``` ts
mockBin(binNameOrConfig, output): Promise<MockBinCleanup>
```

| Parameter         | Type                      | Description                                         |
|-------------------|---------------------------|-----------------------------------------------------|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` + `pattern` |
| `output`          | `string`                  | The text the mock echoes (via `bash`)               |

Mocks the binary so that every invocation prints `output`. The fastest
way to stub a command that just needs to return a string.

#### Full script

``` ts
mockBin(binNameOrConfig, shebang, code): Promise<MockBinCleanup>
```

| Parameter         | Type                      | Description                                         |
|-------------------|---------------------------|-----------------------------------------------------|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` + `pattern` |
| `shebang`         | `string`                  | Interpreter (e.g. `"bash"`, `"node"`)               |
| `code`            | `string`                  | The script body that runs when the mock is invoked  |

Gives full control. The `shebang` accepts a bare interpreter name
(wrapped in `#!/usr/bin/env …` automatically) or a full shebang line.

#### Script file

``` ts
mockBin(binNameOrConfig, shebang, script): Promise<MockBinCleanup>
```

| Parameter         | Type                      | Description                                         |
|-------------------|---------------------------|-----------------------------------------------------|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` + `pattern` |
| `shebang`         | `string`                  | Interpreter used to run the file                    |
| `script`          | `MockBinScriptFile`       | `{ file: string }` pointing at a script on disk     |

Runs a script file through the given interpreter, keeping the file’s
original extension so extension-aware loaders (e.g. `node --import tsx`)
work. Throws if the file does not exist.

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
- [pandoc](https://pandoc.org) ≥ 3.1 — only needed for Markdown
  formatting/linting (`pnpm lint:md` / `pnpm format:md`), not for using
  the library

## Scripts

Run from the repository root:

| Script            | Description                                           |
|-------------------|-------------------------------------------------------|
| `pnpm build`      | Build the library (and workspace packages) to `dist/` |
| `pnpm test`       | Build, run unit tests, then run workspace tests       |
| `pnpm lint`       | Run all linters (Biome, oxlint, ast-grep, pandoc)     |
| `pnpm format`     | Run all formatters with auto-fix                      |
| `pnpm test:watch` | Run unit tests in watch mode                          |

## How it works under the hood

When you call `mockBin(...)`:

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

## Comparison with other tools

| Feature                            | Type-A-Bin | [mock-bin](https://github.com/stevemao/mock-bin) | [mock-a-bin](https://github.com/levibostian/mock-a-bin) |
|------------------------------------|:----------:|:------------------------------------------------:|:-------------------------------------------------------:|
| Mocks any binary via `PATH`        |     ✅     |                        ✅                        |                           ✅                            |
| Runtime dependencies               |     0      |                     several                      |                     several (Deno)                      |
| TypeScript types & overloads       |     ✅     |                        ❌                        |                         partial                         |
| Output shorthand                   |     ✅     |                        ❌                        |                           ❌                            |
| Script-file mode (keeps extension) |     ✅     |                        ❌                        |                           ❌                            |
| Pattern-based conditional mocking  |     ✅     |                        ❌                        |                           ❌                            |
| `run-original` pass-through        |     ✅     |                        ❌                        |                           ✅                            |
| Cleanup function                   |     ✅     |                        ✅                        |                           ✅                            |
| Runtime                            |  Node.js   |                     Node.js                      |                          Deno                           |

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
