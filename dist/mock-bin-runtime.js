import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import Module, { createRequire, registerHooks } from "node:module";
import { basename, delimiter, extname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
// Shared Windows dispatch behind both entry points of a mock:
//
// - the trampoline launcher (native/trampoline.c) starts Node with a
//   generated bootstrap that calls runTrampoline(), and
// - the NODE_OPTIONS preload (mock-bin-preload) calls interceptShim()
//   for the legacy node.exe-hardlink shims.
//
// This module runs inside spawned child processes — as the compiled
// .js from the published package or as the .ts source under node's
// native type stripping — so it must stay free of imports beyond
// node's own modules. The registry env var name is duplicated from
// mock-bin-env for the same reason; the two must stay in sync.
const MOCKS_VAR = "TYPE_A_BIN_MOCKS";
// Subprocess coverage ordering: the observer hook must register after
// the tsx loader — registerHooks chains are LIFO, so only the
// last-registered hook sees the loader's transpiled output, which is
// what NODE_V8_COVERAGE offsets address. Like MOCKS_VAR above, these
// mirror the canonical copies in subprocess-coverage/hook-url.ts (the
// runtime cannot import library modules); keep the two in sync.
const RAW_COVERAGE_ENV = "TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR";
const coverageHookUrl = () => new URL("./subprocess-coverage/coverage-hook.mjs", import.meta.url).href;
const coverageOrderingNeeded = () => (process.env[RAW_COVERAGE_ENV] ?? "") !== "";
const nodeOptionTokens = (nodeOptions) => nodeOptions.split(" ").filter((token) => token !== "");
const isHookImportToken = (hook, tokens, index) => tokens[index] === hook ||
    tokens[index] === `--import=${hook}` ||
    (tokens[index] === "--import" && tokens[index + 1] === hook);
const stripCoverageHookFromNodeOptions = (nodeOptions) => {
    const hook = coverageHookUrl();
    const tokens = nodeOptionTokens(nodeOptions);
    return tokens
        .filter((_, index) => !isHookImportToken(hook, tokens, index))
        .join(" ");
};
// Whether node itself loaded the observer at startup — true only while
// an `--import` entry for it sits in NODE_OPTIONS. The trampoline
// launcher never puts it on its own argv, so NODE_OPTIONS is the only
// startup registration channel this dispatch can see.
const hookPresentInNodeOptions = (nodeOptions) => {
    const hook = coverageHookUrl();
    const tokens = nodeOptionTokens(nodeOptions);
    return tokens.some((_, index) => isHookImportToken(hook, tokens, index));
};
const HELPER_NAME = "mock-a-bin-run-original";
const PATH_EXTENSIONS = ["", ".exe", ".cmd", ".bat", ".com"];
const TS_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"];
const BASH_LIKE_INTERPRETERS = ["bash", "dash", "ksh", "sh", "zsh"];
const readMocks = () => {
    try {
        return JSON.parse(process.env[MOCKS_VAR] ?? "{}");
    }
    catch {
        return {};
    }
};
const writeError = (message) => {
    process.stderr.write(`${message}\n`);
};
// Lookup failures exit 127, matching the POSIX mock scripts.
const fail = (message) => {
    writeError(message);
    process.exit(127);
};
const isFile = (candidate) => {
    try {
        return statSync(candidate).isFile();
    }
    catch {
        return false;
    }
};
const searchPathDirs = (originalPath) => (originalPath ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && !dir.includes("mock-bin-"));
const pathCandidates = (name, dirs) => {
    const candidates = [];
    for (const dir of dirs)
        for (const extension of PATH_EXTENSIONS) {
            const candidate = join(dir, `${name}${extension}`);
            if (isFile(candidate))
                candidates.push(candidate);
        }
    return candidates;
};
const findExecutable = (name, dirs) => pathCandidates(name, dirs)[0] ?? null;
// Runs a resolved command with the caller's stdio and exits with its
// status; a failed spawn exits 127.
const spawnAndExit = (command, args, errorPrefix) => {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error !== undefined)
        writeError(`${errorPrefix}: ${String(result.error)}`);
    process.exit(result.status ?? 127);
};
// The real binary must not be re-intercepted by a shim preload.
const spawnRealAndExit = (command, args) => spawnAndExit(command, args, `Error: '${command}' failed to start`);
const runOriginalCommand = (spec, cliArgs) => {
    if (spec === undefined)
        return fail(`Error: ${HELPER_NAME} used outside a mockBin context`);
    const real = findExecutable(spec.binName, searchPathDirs(spec.originalPath));
    if (real === null)
        return fail(`Error: Original '${spec.binName}' command not found in PATH`);
    return spawnRealAndExit(real, cliArgs);
};
const runRealBinary = (invokedName, cliArgs, originalPath) => {
    const real = findExecutable(invokedName, searchPathDirs(originalPath));
    if (real === null)
        return fail(`Error: Real binary '${invokedName}' not found in PATH`);
    return spawnRealAndExit(real, cliArgs);
};
// WSL's bash launcher lives in the Windows system directories; it cannot
// run Windows-path scripts, so bash-like interpreters prefer a native
// shell (e.g. Git for Windows) and fall back to well-known Git installs.
const isWslLauncher = (candidate) => {
    const lower = candidate.toLowerCase();
    return (lower.includes("\\windows\\system32\\") || lower.includes("\\windowsapps\\"));
};
const gitBashCandidates = () => {
    const roots = [
        process.env.ProgramFiles ?? "",
        process.env["ProgramFiles(x86)"] ?? "",
        join(process.env.LOCALAPPDATA ?? "", "Programs"),
    ];
    const locations = [];
    for (const root of roots)
        if (root !== "") {
            locations.push(join(root, "Git", "bin", "bash.exe"));
            locations.push(join(root, "Git", "usr", "bin", "bash.exe"));
        }
    return locations;
};
const resolveInterpreter = (interpreter) => {
    const dirs = (process.env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => dir !== "");
    const candidates = pathCandidates(interpreter, dirs);
    if (BASH_LIKE_INTERPRETERS.includes(interpreter)) {
        const native = candidates.find((candidate) => !isWslLauncher(candidate));
        if (native !== undefined)
            return native;
        for (const location of gitBashCandidates())
            if (isFile(location))
                return location;
    }
    return candidates[0] ?? null;
};
const runInterpreterAndExit = (interpreter, entry, cliArgs) => {
    const interpreterPath = resolveInterpreter(interpreter);
    if (interpreterPath === null)
        return fail(`Error: Interpreter '${interpreter}' not found in PATH`);
    return spawnAndExit(interpreterPath, [entry, ...cliArgs], `Error: Interpreter '${interpreter}' failed`);
};
// tsx registers its CommonJS hooks from a separate entry point; load it
// lazily so non-TypeScript mocks never require the tsx package.
const loadTsxCommonJs = (entry) => {
    if (!TS_EXTENSIONS.includes(extname(entry).toLowerCase()))
        return;
    try {
        createRequire(import.meta.url)("tsx/cjs");
    }
    catch {
        // tsx is not installed: node's native type stripping applies instead.
    }
};
// Node rewrites the CLI entry in argv[1] to an absolute path before
// preloads run, losing the argument as the caller typed it. Recover it
// relative to the working directory when possible, so mocks, patterns,
// and spawned interpreters see "pr" instead of "C:\repo\pr".
const denormalizeEntry = (entry) => {
    const relativePath = relative(process.cwd(), entry);
    if (relativePath === "" || relativePath.startsWith(".."))
        return entry;
    return relativePath;
};
// Eval/print runs carry their program in execArgv, so argv[1] is
// undefined — the shape runEntryDirectly would otherwise hijack — and a
// helper spawned from inside a mock through the shim must run its
// snippet untouched.
const EVAL_FLAG = /^(?:-e|-p|--eval|--print)(?:=|$)/;
const isEvalRun = (execArgv) => execArgv.some((arg) => EVAL_FLAG.test(arg));
const asPath = (specifier) => specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
// Repositions argv to [node, entry, ...cliArgs] so the mock reads its
// CLI arguments at process.argv.slice(2) like a real Node CLI script.
const setArgvEntry = (entry, cliArgs) => {
    process.argv.length = 1;
    process.argv.push(entry, ...cliArgs);
};
const redirectNodeEntry = (entry, cliArgs) => {
    // Capture the CLI entry before repositioning argv: node normalized it
    // to an absolute path, and the redirects below must recognize it.
    const originalEntry = process.argv[1] ?? "";
    setArgvEntry(entry, cliArgs);
    // ESM main entry: resolve hooks see the main module with no parent URL,
    // so redirect that one resolution to the mock script. The tsx loader
    // (registered before this preload in NODE_OPTIONS) transforms .ts
    // entries as part of the same resolve chain.
    registerHooks({
        resolve: (specifier, context, nextResolve) => {
            if (context.parentURL == null && asPath(specifier) === originalEntry)
                return nextResolve(pathToFileURL(entry).href, context);
            return nextResolve(specifier, context);
        },
    });
    // CommonJS main entry: Module._load receives the CLI entry with isMain
    // set — load the mock through the CommonJS loader instead.
    const moduleApi = Module;
    const originalLoad = moduleApi._load;
    moduleApi._load = (request, parent, isMain) => {
        if (isMain && request === originalEntry) {
            moduleApi._load = originalLoad;
            loadTsxCommonJs(entry);
            return originalLoad(entry, null, true);
        }
        return originalLoad(request, parent, isMain);
    };
};
// A shim spawn with no CLI arguments leaves node without an entry (the
// REPL would start), so the mock module is imported directly instead.
const runEntryDirectly = async (entry, cliArgs) => {
    setArgvEntry(entry, cliArgs);
    await import(pathToFileURL(entry).href);
    // An import settles when the entry's top level finishes — before the
    // output of a mock that defers work (timers, stdin). Node would start
    // the REPL the moment this preload settles, so hold until the event
    // loop drains, then exit with whatever the mock set. A mock holding
    // the loop open on purpose (trapped signals) never drains, and so
    // lives until it is killed.
    await new Promise(() => process.once("beforeExit", () => process.exit(process.exitCode)));
};
// Restarts the process with the tsx loader and the coverage observer
// as ordered argv imports; see runNodeEntryAsMain for why nothing
// shorter works in-process.
const restartWithOrderedObserver = (entry, cliArgs, tsxImportUrl) => {
    const result = spawnSync(process.execPath, [
        "--import",
        tsxImportUrl,
        "--import",
        coverageHookUrl(),
        entry,
        ...cliArgs,
    ], {
        stdio: "inherit",
        env: {
            ...process.env,
            NODE_OPTIONS: stripCoverageHookFromNodeOptions(process.env.NODE_OPTIONS ?? ""),
        },
    });
    if (result.error !== undefined)
        return fail(`Error: Failed to restart node for '${entry}'`);
    process.exit(result.status ?? 1);
};
/**
 * Runs a node-kind mock entry as the process's main module — the
 * trampoline bootstrap's dispatch and, exported for it, the run-cli
 * launcher facade. Unlike a shim, the process already has a real
 * main module (the bootstrap itself), so there is no REPL to avoid and
 * no entry redirection needed. CommonJS entries load through
 * `Module._load` with `isMain` set, so `require.main` matches a script
 * started as `node entry.cjs`; other entries load as ESM, with tsx
 * registered first when the target carries a loader URL.
 */
const runNodeEntryAsMain = async (entry, cliArgs, tsxImportUrl) => {
    setArgvEntry(entry, cliArgs);
    if (extname(entry).toLowerCase() === ".cjs") {
        const moduleApi = Module;
        moduleApi._load(entry, null, true);
        return;
    }
    // Under subprocess coverage the observer must sit above the tsx
    // loader in the LIFO hook chain. A hook registered at startup from
    // an inherited NODE_OPTIONS entry cannot be re-ordered in-process
    // (the hook module loads its loader only once), so the process
    // restarts with loader-then-observer on argv, dropping the inherited
    // entry so the earlier registration cannot win. Without a hook in
    // NODE_OPTIONS there is no startup registration: importing the
    // observer right here, after tsx, gives the same ordering without a
    // second node startup.
    const needsRestart = tsxImportUrl !== undefined &&
        coverageOrderingNeeded() &&
        hookPresentInNodeOptions(process.env.NODE_OPTIONS ?? "");
    if (needsRestart)
        return restartWithOrderedObserver(entry, cliArgs, tsxImportUrl);
    if (tsxImportUrl !== undefined)
        await import(tsxImportUrl);
    if (coverageOrderingNeeded())
        await import(coverageHookUrl());
    await import(pathToFileURL(entry).href);
};
// Dispatch shared by both entry points: a pattern miss hands the
// invocation to the real binary, non-node targets run through their
// interpreter, and node targets load however the entry point chooses.
const dispatchTarget = async (target, invokedName, cliArgs, runNodeEntry) => {
    const commandLine = `${invokedName} ${cliArgs.join(" ")}`;
    const mocked = target.pattern === undefined ||
        new RegExp(target.pattern).test(commandLine);
    if (!mocked)
        return runRealBinary(invokedName, cliArgs, target.originalPath);
    if (target.kind !== "node")
        return runInterpreterAndExit(target.interpreter ?? "bash", target.entry, cliArgs);
    return runNodeEntry(target.entry, cliArgs);
};
// Basename without the executable extension: mock-a-bin-run-original.exe
// and claude.exe both register under their extensionless names.
const toInvokedName = (exePath) => basename(exePath, extname(exePath));
/**
 * Trampoline entry point. The native launcher starts Node as
 * `[node, mock-bin-trampoline.cjs, <mock>.exe, ...originalArgs]`, so the
 * invoked binary is the path in argv[2] and every argument after it is
 * the caller's original argv — Node's option parser never sees it.
 */
const runTrampoline = async () => {
    const invokedExe = process.argv[2];
    if (invokedExe === undefined)
        return fail("Error: type-a-bin trampoline invoked without a mock path");
    const args = process.argv.slice(3);
    const invokedName = toInvokedName(invokedExe);
    const mocks = readMocks();
    if (invokedName === HELPER_NAME)
        return runOriginalCommand(mocks.runOriginal, args);
    const target = mocks.targets?.[invokedName];
    // No registry entry (e.g. a spawn through withoutMocks) must not land
    // in a REPL or a crash: hand the invocation to the real binary.
    if (target === undefined)
        return runRealBinary(invokedName, args, undefined);
    return dispatchTarget(target, invokedName, args, (entry, cliArgs) => runNodeEntryAsMain(entry, cliArgs, target.tsxImportUrl));
};
/**
 * Shim entry point for the NODE_OPTIONS preload: the process itself is
 * a hard link of node.exe named after the mocked binary, so the main
 * entry is redirected in-process once the registry recognizes the
 * invocation. Kept as the fallback behind the trampoline rollout.
 */
const interceptShim = async () => {
    const invokedName = toInvokedName(process.argv[0] ?? "");
    // The shim's whole command line after the exe are CLI arguments:
    // unlike a Node script there is no "entry" consuming the first
    // positional.
    const cliArgs = process.argv.length === 1
        ? []
        : [denormalizeEntry(process.argv[1] ?? ""), ...process.argv.slice(2)];
    if (isEvalRun(process.execArgv))
        return;
    const mocks = readMocks();
    if (invokedName === HELPER_NAME)
        return runOriginalCommand(mocks.runOriginal, cliArgs);
    const target = mocks.targets?.[invokedName];
    if (target === undefined)
        return;
    // A process whose CLI entry is a real file is not a shim: mock scripts
    // spawned through process.execPath (tsx's esbuild service, `node -e`
    // helpers) inherit the shim exe's name, but their entry exists on
    // disk while a shim's "subcommand" entry never does.
    if (isFile(process.argv[1] ?? ""))
        return;
    return dispatchTarget(target, invokedName, cliArgs, process.argv[1] === undefined ? runEntryDirectly : redirectNodeEntry);
};
export { interceptShim, runNodeEntryAsMain, runTrampoline, };
