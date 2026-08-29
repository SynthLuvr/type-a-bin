import { rmSync } from "node:fs";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockBinBehaviour, MockBinHandle } from "./mock-bin-behaviour.js";
import { prepareBehaviour, withCalls } from "./mock-bin-behaviour.js";
import { mockBinWindows } from "./mock-bin-windows.js";

type MockBinCleanup = () => void;

interface MockBinConfig {
  /** The name of the binary to mock (e.g., "gh", "git") */
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

/**
 * Finds the path to a binary within the given PATH directories.
 *
 * @param binName - The name of the binary to find
 * @param pathDirs - Array of directories to search in
 * @returns The full path to the binary, or null if not found
 */
const findBinaryInPath = async (
  binName: string,
  pathDirs: string[],
): Promise<string | null> => {
  for (const dir of pathDirs) {
    if (!dir) continue;

    const binaryPath = path.join(dir, binName);
    try {
      const stats = await stat(binaryPath);
      if (stats.isFile()) return binaryPath;
    } catch {
      // File doesn't exist, continue searching
    }
  }
  return null;
};

type ResolvedScript = { shebang: string; body: string };

/** Wraps a bare interpreter in a `#!/usr/bin/env …` shebang line. */
const toShebangLine = (interpreter: string): string =>
  interpreter.startsWith("#!") ? interpreter : `#!/usr/bin/env ${interpreter}`;

/**
 * Validates the script file exists, then builds an `exec` wrapper that
 * delegates to it through the given interpreter. The file keeps its real
 * extension so extension-aware loaders (e.g. tsx) parse it.
 */
const resolveScriptFile = async (
  shebang: string,
  { file }: MockBinScriptFile,
): Promise<ResolvedScript> => {
  const resolvedFile = path.resolve(file);

  const stats = await stat(resolvedFile).catch(() => null);
  if (!stats?.isFile())
    throw new Error(`mockBin: script file not found: ${file}`);

  // Accept either a bare interpreter ("node --import tsx") or a full
  // shebang line ("#!/usr/bin/env node"); strip "#!" for the exec line.
  const interpreter = shebang.startsWith("#!")
    ? shebang.slice(2).trim()
    : shebang;

  return {
    shebang: "#!/bin/sh",
    body: `exec ${interpreter} "${resolvedFile}" "$@"`,
  };
};

/**
 * Resolves the shebang and body for inline code or the output shorthand.
 * With no `code`, `shebangOrOutput` is echoed via bash.
 */
const resolveInlineCode = (
  shebangOrOutput: string,
  code?: string,
): ResolvedScript => {
  const shebang = code === undefined ? "bash" : shebangOrOutput;
  const body = code ?? `echo "${shebangOrOutput}"`;
  return { shebang: toShebangLine(shebang), body };
};

/**
 * Creates a mock executable that replaces a real binary on the PATH.
 *
 * The mock script can call `mock-a-bin-run-original` to execute the
 * original command, enabling conditional mocking where some subcommands
 * are mocked while others pass through to the real binary.
 *
 * There are four calling conventions:
 *
 * 1. **Output shorthand** — pass the plain text the mock should print.
 *    The interpreter defaults to `bash` and the output is echoed.
 * 2. **Full script** — pass an interpreter (`shebang`) and arbitrary
 *    script `code` to run when the mock binary is invoked.
 * 3. **Script file** — pass an interpreter (`shebang`) and a
 *    `{ file }` object pointing at a script on disk. The file keeps its
 *    own extension, so extension-aware loaders work (e.g.
 *    `node --import tsx` with a `.ts` file).
 * 4. **Scripted behaviour** — pass a `MockBinBehaviour` object instead
 *    of a script. The mock records every invocation on the returned
 *    handle's `calls`, and the object scripts the output, exit code and
 *    timing without writing a script at all.
 *
 * @param binNameOrConfig - Binary name or a config object with `binName`
 *   and an optional `pattern`
 * @returns A cleanup function that restores the original PATH
 *
 * @example
 * ```ts
 * // Output shorthand
 * const cleanup = await mockBin("gh", "mocked!!")
 * ```
 *
 * @example
 * ```ts
 * // Full script
 * const cleanup = await mockBin("gh", "bash", 'echo "mocked!!"')
 * // ... run your tests ...
 * cleanup() // Restore original PATH
 * ```
 *
 * @example
 * ```ts
 * // Script file (keeps its extension, so tsx transforms it)
 * const cleanup = await mockBin("dragon", "node --import tsx", {
 *   file: "./src/tests/hoard-script.ts",
 * })
 * ```
 *
 * @example
 * ```ts
 * // Scripted behaviour, with the invocations recorded
 * const mock = await mockBin("gh", { stdout: ["#1", "#2"], exitCode: 1 })
 * expect(mock.calls[0]?.args).toEqual(["pr", "list"])
 * mock() // The handle is the cleanup function
 * ```
 */
function mockBin(
  binNameOrConfig: string | MockBinConfig,
  output: string,
): Promise<MockBinCleanup>;
function mockBin(
  binNameOrConfig: string | MockBinConfig,
  behaviour: MockBinBehaviour,
): Promise<MockBinHandle>;
function mockBin(
  binNameOrConfig: string | MockBinConfig,
  shebang: string,
  code: string,
): Promise<MockBinCleanup>;
function mockBin(
  binNameOrConfig: string | MockBinConfig,
  shebang: string,
  script: MockBinScriptFile,
): Promise<MockBinCleanup>;
async function mockBin(
  binNameOrConfig: string | MockBinConfig,
  shebangOrOutput: string | MockBinBehaviour,
  codeOrScript?: string | MockBinScriptFile,
): Promise<MockBinCleanup> {
  const config =
    typeof binNameOrConfig === "string"
      ? { binName: binNameOrConfig }
      : binNameOrConfig;
  const { binName, pattern } = config;

  // A scripted behaviour compiles to a node mock that carries its own
  // pattern check, so it installs through the ordinary inline-code path
  // on both platforms and only the call recorder is layered on top.
  if (typeof shebangOrOutput === "object") {
    const { code, recordDir } = await prepareBehaviour(
      binName,
      pattern,
      shebangOrOutput,
    );
    return withCalls(await mockBin(binName, "node", code), recordDir);
  }

  // Windows needs a real .exe on the PATH plus a NODE_OPTIONS preload
  // that redirects the shim's entry to the mock script; everything else
  // (pattern handling, cleanup contract) behaves the same.
  if (process.platform === "win32")
    return mockBinWindows(binName, pattern, shebangOrOutput, codeOrScript);

  const originalPath = process.env.PATH ?? "";
  const pathSeparator = path.delimiter;

  const tempDir = await mkdtemp(path.join(tmpdir(), "mock-bin-"));
  const mockScriptPath = path.join(tempDir, binName);
  const runOriginalBinaryPath = path.join(tempDir, "mock-a-bin-run-original");

  // Create the 'mock-a-bin-run-original' helper binary. The user's mock
  // script can call it to delegate back to the real binary.
  const runOriginalScript = `#!/bin/bash
# This binary finds and executes the original command
# It's called when the mock script decides to delegate to the real binary

# Restore original PATH to find the real binary
export PATH="${originalPath}"

# Find the original binary (excluding our temp directory)
ORIGINAL_BIN=$(command -v "${binName}" 2>/dev/null)

if [ -n "$ORIGINAL_BIN" ]; then
  # Execute the original binary with all arguments
  exec "$ORIGINAL_BIN" "$@"
else
  echo "Error: Original '${binName}' command not found in PATH" >&2
  exit 127
fi
`;

  await writeFile(runOriginalBinaryPath, runOriginalScript);
  await chmod(runOriginalBinaryPath, 0o755);

  const { shebang, body } =
    typeof codeOrScript === "object"
      ? await resolveScriptFile(shebangOrOutput, codeOrScript)
      : resolveInlineCode(shebangOrOutput, codeOrScript);

  // When a pattern is given, wrap the body so only matching commands
  // are mocked; everything else is delegated to the real binary.
  let userScriptContent: string;
  if (pattern) {
    const pathsWithoutTemp = originalPath
      .split(pathSeparator)
      .filter((p) => p && !p.includes("mock-bin-"));
    const realBinaryPath = await findBinaryInPath(binName, pathsWithoutTemp);

    userScriptContent = `${shebang}
# Construct the full command with arguments
FULL_COMMAND="${binName} $*"

# Check if the command matches the pattern
if echo "$FULL_COMMAND" | grep -qE '${pattern}'; then
  # Pattern matches - execute mock code
${body}
else
  # Pattern doesn't match - execute the real binary
  ${realBinaryPath ? `exec "${realBinaryPath}" "$@"` : `echo "Error: Real binary '${binName}' not found in PATH" >&2; exit 127`}
fi
`;
  } else {
    userScriptContent = `${shebang}\n${body}\n`;
  }

  // Write the mock script directly to the binary path so it replaces the
  // real binary on the PATH (no wrapper indirection needed: the shebang
  // selects the interpreter).
  await writeFile(mockScriptPath, userScriptContent);
  await chmod(mockScriptPath, 0o755);

  // Prepend the temp directory to PATH so the mock takes precedence.
  process.env.PATH = `${tempDir}${pathSeparator}${originalPath}`;

  return (): void => {
    if (originalPath) process.env.PATH = originalPath;
    else delete process.env.PATH;

    try {
      rmSync(tempDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors - temp dir will be cleaned up eventually
      console.warn(
        `Warning: Failed to remove mock-bin temp directory ${tempDir}: ${String(error)}`,
      );
    }
  };
}

export {
  type MockBinCleanup,
  type MockBinConfig,
  type MockBinScriptFile,
  mockBin,
};
