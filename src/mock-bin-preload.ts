import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import Module, { createRequire, registerHooks } from "node:module";
import { basename, delimiter, extname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";

// Loaded through `NODE_OPTIONS --import` into every Node process a test
// spawns while Windows mocks are active. A mock binary is a hard link of
// node.exe renamed <bin>.exe, so the command line ("status", "--porcelain",
// ...) is not a real module. This preload swaps the shim's main entry for
// the mock script named in TYPE_A_BIN_MOCKS — argv, stdin, stdout, stderr,
// and exit codes all pass through unchanged.
const MOCKS_VAR = "TYPE_A_BIN_MOCKS";
const HELPER_NAME = "mock-a-bin-run-original";
const PATH_EXTENSIONS = ["", ".exe", ".cmd", ".bat", ".com"];
const TS_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"];
const BASH_LIKE_INTERPRETERS = ["bash", "dash", "ksh", "sh", "zsh"];

interface MockTarget {
  /** "node" redirects the main entry in-process; "spawn" runs a script. */
  kind: "node" | "spawn";
  /** Absolute path of the mock script to run. */
  entry: string;
  /** Interpreter name for "spawn" targets (e.g. "bash", "python"). */
  interpreter?: string;
  /** Regex source; only matching commands run the mock. */
  pattern?: string;
  /** PATH snapshot from before this mock was installed. */
  originalPath?: string;
}

interface RunOriginalTarget {
  binName: string;
  originalPath: string;
}

interface MocksEnv {
  targets?: Record<string, MockTarget>;
  runOriginal?: RunOriginalTarget;
}

interface LoadableModule {
  /** Internal CommonJS entry point, patched to redirect the main module. */
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
}

const readMocks = (): MocksEnv => {
  try {
    return JSON.parse(process.env[MOCKS_VAR] ?? "{}") as MocksEnv;
  } catch {
    return {};
  }
};

const mocks = readMocks();
const invokedName = basename(
  process.argv[0] ?? "",
  extname(process.argv[0] ?? ""),
);

// Node rewrites the CLI entry in argv[1] to an absolute path before
// preloads run, losing the argument as the caller typed it. Recover it
// relative to the working directory when possible, so mocks, patterns,
// and spawned interpreters see "pr" instead of "C:\repo\pr".
const denormalizeEntry = (entry: string): string => {
  const relativePath = relative(process.cwd(), entry);
  if (relativePath === "" || relativePath.startsWith("..")) return entry;
  return relativePath;
};

// The shim's whole command line after the exe are CLI arguments: unlike
// a Node script there is no "entry" consuming the first positional.
const cliArgs =
  process.argv.length === 1
    ? []
    : [denormalizeEntry(process.argv[1] ?? ""), ...process.argv.slice(2)];

const writeError = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

// Lookup failures exit 127, matching the POSIX mock scripts.
const fail = (message: string): never => {
  writeError(message);
  process.exit(127);
};

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const searchPathDirs = (originalPath: string | undefined): string[] =>
  (originalPath ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && !dir.includes("mock-bin-"));

const pathCandidates = (name: string, dirs: string[]): string[] => {
  const candidates: string[] = [];
  for (const dir of dirs)
    for (const extension of PATH_EXTENSIONS) {
      const candidate = join(dir, `${name}${extension}`);
      if (isFile(candidate)) candidates.push(candidate);
    }
  return candidates;
};

const findExecutable = (name: string, dirs: string[]): string | null =>
  pathCandidates(name, dirs)[0] ?? null;

const spawnRealAndExit = (command: string, args: string[]): never => {
  // The real binary must not be re-intercepted by this preload.
  delete process.env[MOCKS_VAR];
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error !== undefined)
    writeError(`Error: '${command}' failed to start: ${String(result.error)}`);
  process.exit(result.status ?? 127);
};

const runOriginalCommand = (spec: RunOriginalTarget | undefined): never => {
  if (spec === undefined)
    return fail(`Error: ${HELPER_NAME} used outside a mockBin context`);
  const real = findExecutable(spec.binName, searchPathDirs(spec.originalPath));
  if (real === null)
    return fail(`Error: Original '${spec.binName}' command not found in PATH`);
  return spawnRealAndExit(real, cliArgs);
};

const runRealBinary = (target: MockTarget): never => {
  const real = findExecutable(invokedName, searchPathDirs(target.originalPath));
  if (real === null)
    return fail(`Error: Real binary '${invokedName}' not found in PATH`);
  return spawnRealAndExit(real, cliArgs);
};

// WSL's bash launcher lives in the Windows system directories; it cannot
// run Windows-path scripts, so bash-like interpreters prefer a native
// shell (e.g. Git for Windows) and fall back to well-known Git installs.
const isWslLauncher = (candidate: string): boolean => {
  const lower = candidate.toLowerCase();
  return (
    lower.includes("\\windows\\system32\\") || lower.includes("\\windowsapps\\")
  );
};

const gitBashCandidates = (): string[] => {
  const roots = [
    process.env.ProgramFiles ?? "",
    process.env["ProgramFiles(x86)"] ?? "",
    join(process.env.LOCALAPPDATA ?? "", "Programs"),
  ];
  const locations: string[] = [];
  for (const root of roots)
    if (root !== "") {
      locations.push(join(root, "Git", "bin", "bash.exe"));
      locations.push(join(root, "Git", "usr", "bin", "bash.exe"));
    }
  return locations;
};

const resolveInterpreter = (interpreter: string): string | null => {
  const dirs = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "");
  const candidates = pathCandidates(interpreter, dirs);
  if (BASH_LIKE_INTERPRETERS.includes(interpreter)) {
    const native = candidates.find((candidate) => !isWslLauncher(candidate));
    if (native !== undefined) return native;
    for (const location of gitBashCandidates())
      if (isFile(location)) return location;
  }
  return candidates[0] ?? null;
};

const runInterpreterAndExit = (interpreter: string, entry: string): never => {
  const interpreterPath = resolveInterpreter(interpreter);
  if (interpreterPath === null)
    return fail(`Error: Interpreter '${interpreter}' not found in PATH`);
  const result = spawnSync(interpreterPath, [entry, ...cliArgs], {
    stdio: "inherit",
  });
  if (result.error !== undefined)
    writeError(
      `Error: Interpreter '${interpreter}' failed: ${String(result.error)}`,
    );
  process.exit(result.status ?? 127);
};

const asPath = (specifier: string): string =>
  specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;

// tsx registers its CommonJS hooks from a separate entry point; load it
// lazily so non-TypeScript mocks never require the tsx package.
const loadTsxCommonJs = (entry: string): void => {
  if (!TS_EXTENSIONS.includes(extname(entry).toLowerCase())) return;
  try {
    createRequire(import.meta.url)("tsx/cjs");
  } catch {
    // tsx is not installed: node's native type stripping applies instead.
  }
};

const redirectNodeEntry = (entry: string): void => {
  // Node normalizes the CLI entry to an absolute path in argv[1] before
  // preloads run. Capture it, then reposition argv so the mock sees the
  // CLI arguments at process.argv.slice(2) like a real Node CLI script.
  const originalEntry = process.argv[1] ?? "";
  process.argv.length = 1;
  process.argv.push(entry, ...cliArgs);

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
  const moduleApi = Module as unknown as LoadableModule;
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

// A spawn with no CLI arguments leaves node without an entry (the REPL
// would start), so the mock module is imported directly instead.
const runEntryDirectly = async (entry: string): Promise<void> => {
  process.argv.length = 1;
  process.argv.push(entry, ...cliArgs);
  await import(pathToFileURL(entry).href);
  // Importing settles when the entry's top level finishes, which for a
  // mock that defers work (timers, stdin, an import of its own) is
  // before its output exists. Node would start the REPL the moment this
  // preload settles — the shim has no CLI entry — so hold here until the
  // event loop drains, then exit with whatever the mock set. A mock that
  // keeps the loop alive on purpose (trapped signals) never drains, and
  // so lives until it is killed.
  await new Promise<void>(() =>
    process.once("beforeExit", () => process.exit(process.exitCode)),
  );
};

const intercept = async (): Promise<void> => {
  if (invokedName === HELPER_NAME) return runOriginalCommand(mocks.runOriginal);
  const target = mocks.targets?.[invokedName];
  if (target === undefined) return;
  // A process whose CLI entry is a real file is not a shim: mock scripts
  // spawned through process.execPath (tsx's esbuild service, `node -e`
  // helpers) inherit the shim exe's name, but their entry exists on disk
  // while a shim's "subcommand" entry never does.
  if (isFile(process.argv[1] ?? "")) return;
  const commandLine = `${invokedName} ${cliArgs.join(" ")}`;
  const mocked =
    target.pattern === undefined ||
    new RegExp(target.pattern).test(commandLine);
  if (!mocked) return runRealBinary(target);
  if (target.kind !== "node")
    return runInterpreterAndExit(target.interpreter ?? "bash", target.entry);
  if (process.argv[1] === undefined) return runEntryDirectly(target.entry);
  return redirectNodeEntry(target.entry);
};

// Only a shim's own main thread may intercept: loaders such as tsx spawn
// workers whose entry-point load must pass through untouched.
if (process.env[MOCKS_VAR] !== undefined && threadId === 0) await intercept();

export type { MocksEnv, MockTarget };
