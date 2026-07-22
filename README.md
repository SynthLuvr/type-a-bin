# Type-A-Bin

> Mock any executable binary

Have a script that executes shell commands? Want to test those scripts
by mocking the commands they run? Type-A-Bin lets you mock any
executable binary by injecting a mock script into your `PATH`.

This is a Node.js alternative to the npm package
[mock-bin](https://github.com/stevemao/mock-bin).

## Usage

### Basic Usage - Mock All Commands

``` ts
import { execFileSync } from "node:child_process";
import { mockBin } from "type-a-bin";

// Mock the 'gh' command to return custom output
const cleanup = await mockBin(
  "gh", // binName: the command to mock
  "bash", // shebang: interpreter that runs your code
  'echo "mocked output"', // code: the script that gets executed
);

// Now any calls to 'gh' will execute the mock script
const output = execFileSync("gh", ["pr", "list"], { encoding: "utf-8" });
console.log(output); // "mocked output\n"

cleanup(); // Restore original PATH
```

## Conditional Mocking

Sometimes you want to mock only specific commands or subcommands while
allowing others to run normally. There are two approaches:

### Option 1: Pattern-Based Mocking

Use regex patterns to automatically mock only specific commands while
allowing others to run normally:

``` ts
import { mockBin } from "type-a-bin";

// Mock only 'gh pr list' and 'gh pr view' commands
const cleanup = await mockBin(
  {
    binName: "gh",
    pattern: "^gh pr (list|view)", // regex to match against the full command
  },
  "bash",
  'echo "mocked PR command"',
);

cleanup(); // Restore original PATH
```

### Option 2: Script-Based Mocking with `mock-a-bin-run-original`

When you create a mock with `mockBin()`, a helper binary called
`mock-a-bin-run-original` is created alongside it. Your mock script can
call this binary to execute the original command, giving you flexibility
to decide in your own script logic whether to mock or pass through:

``` ts
import { mockBin } from "type-a-bin";

// Mock only "git status" but pass through everything else
const cleanup = await mockBin("git", "bash", `
  if [ "$1" = "status" ]; then
    echo "Everything is clean!"
  else
    mock-a-bin-run-original "$@"
  fi
`);

cleanup();
```

This works with any interpreter (bash, node, python, etc.).

## API

### `mockBin(binNameOrConfig, shebang, code)`

Creates a mock executable and prepends it to `PATH`. Returns a cleanup
function that restores the original `PATH` and removes the temp
directory.

| Parameter         | Type                      | Description                                           |
|-------------------|---------------------------|-------------------------------------------------------|
| `binNameOrConfig` | `string \| MockBinConfig` | Binary name, or a config with `binName` and `pattern` |
| `shebang`         | `string`                  | Interpreter (e.g., `"bash"`, `"node"`)                |
| `code`            | `string`                  | Script code to execute when the mock runs             |

Returns `Promise<() => void>` — call the returned function to restore
the original `PATH`.

## Prerequisites

- [Node.js](https://nodejs.org) 26 and [pnpm](https://pnpm.io) (enforced
  via `engines`)
- [pandoc](https://pandoc.org) ≥ 3.1 — required by `pnpm lint:md` /
  `pnpm format:md`

## Quick Start

``` bash
pnpm install
pnpm build    # type-check with tsc
pnpm test     # run unit tests
```

## Scripts

| Script            | Description                               |
|-------------------|-------------------------------------------|
| `pnpm build`      | Type-check the project with `tsc`         |
| `pnpm lint`       | Run all linters (biome, oxlint, ast-grep) |
| `pnpm format`     | Run all formatters (auto-fix)             |
| `pnpm test`       | Run unit tests                            |

## Special Thanks

This project was inspired by and is a Node.js equivalent of
[mock-bin](https://github.com/stevemao/mock-bin) by [Steve
Mao](https://github.com/stevemao).
