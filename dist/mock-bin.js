import { rmSync } from "node:fs";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
/**
 * Finds the path to a binary within the given PATH directories.
 *
 * @param binName - The name of the binary to find
 * @param pathDirs - Array of directories to search in
 * @returns The full path to the binary, or null if not found
 */
const findBinaryInPath = async (binName, pathDirs) => {
    for (const dir of pathDirs) {
        if (!dir)
            continue;
        const binaryPath = path.join(dir, binName);
        try {
            const stats = await stat(binaryPath);
            if (stats.isFile())
                return binaryPath;
        }
        catch {
            // File doesn't exist, continue searching
        }
    }
    return null;
};
/** Wraps a bare interpreter in a `#!/usr/bin/env …` shebang line. */
const toShebangLine = (interpreter) => interpreter.startsWith("#!") ? interpreter : `#!/usr/bin/env ${interpreter}`;
/**
 * Validates the script file exists, then builds an `exec` wrapper that
 * delegates to it through the given interpreter. The file keeps its real
 * extension so extension-aware loaders (e.g. tsx) parse it.
 */
const resolveScriptFile = async (shebang, { file }) => {
    const resolvedFile = path.resolve(file);
    const stats = await stat(resolvedFile).catch(() => null);
    if (!stats?.isFile()) {
        throw new Error(`mockBin: script file not found: ${file}`);
    }
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
const resolveInlineCode = (shebangOrOutput, code) => {
    const shebang = code === undefined ? "bash" : shebangOrOutput;
    const body = code ?? `echo "${shebangOrOutput}"`;
    return { shebang: toShebangLine(shebang), body };
};
async function mockBin(binNameOrConfig, shebangOrOutput, codeOrScript) {
    const config = typeof binNameOrConfig === "string"
        ? { binName: binNameOrConfig }
        : binNameOrConfig;
    const { binName, pattern } = config;
    const originalPath = process.env.PATH ?? "";
    const pathSeparator = process.platform === "win32" ? ";" : ":";
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
    const { shebang, body } = typeof codeOrScript === "object"
        ? await resolveScriptFile(shebangOrOutput, codeOrScript)
        : resolveInlineCode(shebangOrOutput, codeOrScript);
    // When a pattern is given, wrap the body so only matching commands
    // are mocked; everything else is delegated to the real binary.
    let userScriptContent;
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
    }
    else {
        userScriptContent = `${shebang}\n${body}\n`;
    }
    // Write the mock script directly to the binary path so it replaces the
    // real binary on the PATH (no wrapper indirection needed: the shebang
    // selects the interpreter).
    await writeFile(mockScriptPath, userScriptContent);
    await chmod(mockScriptPath, 0o755);
    // Prepend the temp directory to PATH so the mock takes precedence.
    process.env.PATH = `${tempDir}${pathSeparator}${originalPath}`;
    return () => {
        if (originalPath)
            process.env.PATH = originalPath;
        else
            delete process.env.PATH;
        try {
            rmSync(tempDir, { recursive: true });
        }
        catch (error) {
            // Ignore cleanup errors - temp dir will be cleaned up eventually
            console.warn(`Warning: Failed to remove mock-bin temp directory ${tempDir}: ${String(error)}`);
        }
    };
}
export { mockBin, };
