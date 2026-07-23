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
const mockBin = async (binNameOrConfig, shebangOrOutput, code) => {
    const config = typeof binNameOrConfig === "string"
        ? { binName: binNameOrConfig }
        : binNameOrConfig;
    const { binName, pattern } = config;
    // When only two arguments are supplied the second one is the output to
    // print; wrap it in an echo and default to a bash interpreter.
    const shebang = code === undefined ? "bash" : shebangOrOutput;
    const scriptCode = code ?? `echo "${shebangOrOutput}"`;
    const normalizedShebang = shebang.startsWith("#!")
        ? shebang
        : `#!/usr/bin/env ${shebang}`;
    const originalPath = process.env.PATH ?? "";
    const pathSeparator = process.platform === "win32" ? ";" : ":";
    const tempDir = await mkdtemp(path.join(tmpdir(), "mock-bin-"));
    const mockScriptPath = path.join(tempDir, binName);
    const userScriptPath = path.join(tempDir, `.${binName}-user-script`);
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
    // When a pattern is given, wrap the user code so only matching commands
    // are mocked; everything else is delegated to the real binary.
    let userScriptContent;
    if (pattern) {
        const pathsWithoutTemp = originalPath
            .split(pathSeparator)
            .filter((p) => p && !p.includes("mock-bin-"));
        const realBinaryPath = await findBinaryInPath(binName, pathsWithoutTemp);
        userScriptContent = `${normalizedShebang}
# Construct the full command with arguments
FULL_COMMAND="${binName} $*"

# Check if the command matches the pattern
if echo "$FULL_COMMAND" | grep -qE '${pattern}'; then
  # Pattern matches - execute mock code
${scriptCode}
else
  # Pattern doesn't match - execute the real binary
  ${realBinaryPath ? `exec "${realBinaryPath}" "$@"` : `echo "Error: Real binary '${binName}' not found in PATH" >&2; exit 127`}
fi
`;
    }
    else {
        userScriptContent = `${normalizedShebang}\n${scriptCode}\n`;
    }
    await writeFile(userScriptPath, userScriptContent);
    await chmod(userScriptPath, 0o755);
    // Create the main wrapper script that just runs the user's script.
    const wrapperScript = `#!/bin/bash
# Run the user's mock script with all arguments
exec "${userScriptPath}" "$@"
`;
    await writeFile(mockScriptPath, wrapperScript);
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
};
export { mockBin };
