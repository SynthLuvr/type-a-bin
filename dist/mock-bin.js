import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareBehaviour, withCalls } from "./mock-bin-behaviour.js";
import { isTypeScriptFile, resolveTsxImportUrl } from "./mock-bin-tsx.js";
import { mockBinWindows } from "./mock-bin-windows.js";
import { rmScratch } from "./rm-scratch.js";
import { coverageHookUrl, RAW_COVERAGE_ENV, stripCoverageHookFromNodeOptions, } from "./subprocess-coverage/hook-url.js";
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
const resolveExistingFile = async (file) => {
    const resolvedFile = path.resolve(file);
    const stats = await stat(resolvedFile).catch(() => null);
    if (!stats?.isFile())
        throw new Error(`mockBin: script file not found: ${file}`);
    return resolvedFile;
};
// A node interpreter that loads a loader through --import must run the
// coverage observer after it: registerHooks chains are LIFO, and only
// a hook registered after a transforming loader sees the transpiled
// code (and its inline source map) whose offsets the raw profile
// addresses. Interpreters that already load the hook are left alone.
const loadsLoaderThroughImport = (interpreter, hook) => interpreter.includes("node") &&
    interpreter.includes("--import") &&
    !interpreter.includes(hook);
// Wrapper that appends the observer to the exec line when the child
// opts into subprocess coverage. NODE_OPTIONS is pinned to a
// hook-stripped value because the hook module registers its loader
// only once — an inherited --import entry would register ahead of the
// interpreter's loaders and win. The branch runs in the child, not at
// install time, because a suite may wire propagation only into the
// spawned env.
const observerOrderedBody = (interpreter, resolvedFile) => {
    const nodeOptions = stripCoverageHookFromNodeOptions(process.env.NODE_OPTIONS ?? "");
    return [
        `if [ -n "$${RAW_COVERAGE_ENV}" ]; then`,
        `  NODE_OPTIONS="${nodeOptions}"`,
        `  exec ${interpreter} --import ${coverageHookUrl()} "${resolvedFile}" "$@"`,
        "fi",
        `exec ${interpreter} "${resolvedFile}" "$@"`,
    ].join("\n");
};
/**
 * Validates the script file exists, then builds an `exec` wrapper that
 * delegates to it through the given interpreter. The file keeps its real
 * extension so extension-aware loaders (e.g. tsx) parse it.
 */
const resolveScriptFile = async (shebang, { file }) => {
    const resolvedFile = await resolveExistingFile(file);
    // Accept either a bare interpreter ("node --import tsx") or a full
    // shebang line ("#!/usr/bin/env node"); strip "#!" for the exec line.
    const interpreter = shebang.startsWith("#!")
        ? shebang.slice(2).trim()
        : shebang;
    const hook = coverageHookUrl();
    if (loadsLoaderThroughImport(interpreter, hook))
        return {
            shebang: "#!/bin/sh",
            body: observerOrderedBody(interpreter, resolvedFile),
        };
    return {
        shebang: "#!/bin/sh",
        body: `exec ${interpreter} "${resolvedFile}" "$@"`,
    };
};
/** Discriminates the script-file shorthand from a behaviour object. */
const isScriptFile = (value) => typeof value === "object" &&
    "file" in value &&
    typeof value.file === "string";
/**
 * Picks the interpreter for the script-file shorthand from the file's
 * extension: TypeScript runs through the tsx loader resolved to an
 * absolute file URL — so the mock works from any working directory —
 * `.js` through node, `.sh` through bash. Anything else must name its
 * interpreter explicitly.
 */
const scriptFileInterpreter = async (script) => {
    const resolvedFile = await resolveExistingFile(script.file);
    if (isTypeScriptFile(resolvedFile)) {
        const tsxImportUrl = resolveTsxImportUrl(resolvedFile);
        // Without tsx, node's native type stripping still parses erasable
        // TypeScript.
        return tsxImportUrl === null ? "node" : `node --import ${tsxImportUrl}`;
    }
    const extension = path.extname(resolvedFile).toLowerCase();
    if ([".cjs", ".js", ".mjs"].includes(extension))
        return "node";
    if (extension === ".sh")
        return "bash";
    throw new Error(`mockBin: no interpreter known for '${extension || "no extension"}' script files; pass one explicitly, e.g. ` +
        `mockBin(bin, "node", { file })`);
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
    // Script-file shorthand: pick the interpreter, then take the explicit
    // interpreter + script-file path.
    if (isScriptFile(shebangOrOutput))
        return mockBin(config, await scriptFileInterpreter(shebangOrOutput), shebangOrOutput);
    // A scripted behaviour compiles to a node mock that carries its own
    // pattern check, so it installs through the ordinary inline-code path
    // on both platforms and only the call recorder is layered on top.
    if (typeof shebangOrOutput === "object") {
        const { code, recordDir } = await prepareBehaviour(binName, pattern, shebangOrOutput);
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
        rmScratch(tempDir);
    };
}
export { mockBin, };
